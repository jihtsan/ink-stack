import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { DashboardDraft } from "@ink-stack/shared";
import { collectWeather, type QWeatherConnection, type QWeatherTransport, type WeatherCacheEntry } from "@ink-stack/widgets/weather/server";
import type { WeatherConfig, WeatherEnvelope } from "@ink-stack/widgets/weather/types";
import { validateWidgetInstanceConfig } from "@ink-stack/widgets";
import type { InkDatabase } from "../storage/database.js";
import { readCodexLimits, type CodexLimitsResult } from "../connectors/codex-app-server.js";
import { QWeatherHttpClient } from "../connectors/qweather.js";
import { CredentialStore } from "./credentials.js";

export type ConnectionType = "codex-local" | "qweather" | "google-calendar-oauth" | "google-oauth-app";

export interface Connection {
  id: string;
  type: ConnectionType;
  name: string;
  revision: number;
  settings: Record<string, unknown>;
  configured: boolean;
}

export interface WeatherConnectionInput {
  name: string;
  apiHost: string;
  authMode: "jwt" | "api-key";
  apiKey: string;
}

export interface WeatherConnection extends Connection {
  type: "qweather";
  apiHost: string;
  authMode: "jwt" | "api-key";
  apiVersion: "v1" | "v7";
  credentialConfigured: boolean;
}

interface WeatherSettings {
  apiHost: string;
  authMode: "jwt" | "api-key";
  apiVersion: "v1" | "v7";
  credentialId: string;
  authRevision: number;
  identity: string;
}

export interface ConnectionsOptions {
  masterKey?: Buffer;
  weatherTransport?: QWeatherTransport;
  /** Test-only simulated upstream; production leaves this unset. */
  weatherTestTransport?: QWeatherTransport;
}

export class Connections {
  readonly credentials: CredentialStore;
  private cached?: CodexLimitsResult;
  private cacheAt = 0;
  private pending?: Promise<CodexLimitsResult>;
  private lastGood?: CodexLimitsResult;
  private readonly weatherTransport?: QWeatherTransport;
  private readonly weatherTestTransport?: QWeatherTransport;
  private readonly weatherCache = new Map<string, WeatherCacheEntry>();
  private readonly weatherPending = new Map<string, Promise<{ envelope: WeatherEnvelope; cache?: WeatherCacheEntry }>>();

  constructor(private db: InkDatabase, private reader: () => Promise<CodexLimitsResult> = () => readCodexLimits(), options: ConnectionsOptions = {}) {
    this.credentials = new CredentialStore(db, options.masterKey, (connection) => this.invalidate(connection));
    this.weatherTransport = options.weatherTransport ?? new QWeatherHttpClient(this.credentials).transport;
    this.weatherTestTransport = options.weatherTestTransport;
    db.prepare("INSERT OR IGNORE INTO connections VALUES (?,?,?)").run("local-codex-app-server", "codex-local", "本机 Codex");
    db.prepare("INSERT OR IGNORE INTO connection_versions VALUES (?,?,?)").run("local-codex-app-server", 1, "{}");
  }

  /** Backwards-compatible Codex-only catalog used by the existing account UI. */
  list(): Connection[] {
    return this.listType("codex-local");
  }

  listType(type: ConnectionType): Connection[] {
    const rows = this.db.prepare("SELECT c.id,c.type,c.name,v.revision,v.settings FROM connections c JOIN connection_versions v ON c.id=v.connection_id WHERE c.type=? ORDER BY c.name,v.revision").all(type) as Array<{ id: string; type: ConnectionType; name: string; revision: number; settings: string }>;
    return rows.map((row) => this.publicConnection(row));
  }

  get(id: string, revision: number): Connection | undefined {
    const row = this.db.prepare("SELECT c.id,c.type,c.name,v.revision,v.settings FROM connections c JOIN connection_versions v ON c.id=v.connection_id WHERE c.id=? AND v.revision=?").get(id, revision) as { id: string; type: ConnectionType; name: string; revision: number; settings: string } | undefined;
    return row ? this.publicConnection(row) : undefined;
  }

  create(name: string): Connection {
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO connections VALUES (?,?,?)").run(id, "codex-local", name);
      this.db.prepare("INSERT INTO connection_versions VALUES (?,?,?)").run(id, 1, "{}");
    })();
    return this.get(id, 1)!;
  }

  version(id: string): Connection {
    const connection = this.getLatest(id);
    if (!connection || connection.type !== "codex-local") throw new Error("connection_not_found");
    const revision = connection.revision + 1;
    this.db.prepare("INSERT INTO connection_versions VALUES (?,?,?)").run(id, revision, "{}");
    return this.get(id, revision)!;
  }

  createWeather(input: WeatherConnectionInput): WeatherConnection {
    const name = input.name.trim().slice(0, 80);
    if (!name || !validWeatherHost(input.apiHost) || !["jwt", "api-key"].includes(input.authMode) || !input.apiKey.trim() || input.apiKey.length > 8192) {
      throw new Error("invalid_weather_connection");
    }
    const id = randomUUID();
    const credentialId = `qweather:${id}:${randomBytes(12).toString("hex")}`;
    const settings: WeatherSettings = {
      apiHost: input.apiHost.toLowerCase(), authMode: input.authMode, apiVersion: "v1", credentialId,
      authRevision: 1, identity: hashIdentity(id, 1, 1)
    };
    // The connection row is created before the credential so CredentialStore
    // can enforce ownership. If encryption is unavailable, no row is left.
    try {
      this.db.transaction(() => {
        this.db.prepare("INSERT INTO connections VALUES (?,?,?)").run(id, "qweather", name);
        this.db.prepare("INSERT INTO connection_versions VALUES (?,?,?)").run(id, 1, JSON.stringify(settings));
        this.credentials.write(id, credentialId, { action: "replace", value: input.apiKey });
      })();
    } catch (error) {
      this.db.prepare("DELETE FROM connections WHERE id=?").run(id);
      throw error;
    }
    return this.getWeatherPublic(id, 1)!;
  }

  rotateWeatherCredential(id: string, revision: number, value: string): WeatherConnection {
    const current = this.getWeatherSettings(id, revision);
    if (!current || !value.trim() || value.length > 8192) throw new Error("invalid_weather_connection");
    const nextRevision = revision + 1;
    const next: WeatherSettings = { ...current.settings, authRevision: current.settings.authRevision + 1, identity: hashIdentity(id, nextRevision, current.settings.authRevision + 1) };
    this.db.transaction(() => {
      this.credentials.write(id, current.settings.credentialId, { action: "replace", value });
      this.db.prepare("INSERT INTO connection_versions VALUES (?,?,?)").run(id, nextRevision, JSON.stringify(next));
    })();
    this.invalidate(id);
    return this.getWeatherPublic(id, nextRevision)!;
  }

  getWeatherPublic(id: string, revision: number): WeatherConnection | undefined {
    const row = this.getRaw(id, revision);
    if (!row || row.type !== "qweather") return undefined;
    const settings = parseWeatherSettings(row.settings);
    if (!settings) return undefined;
    const configured = this.credentials.has(id, settings.credentialId);
    return {
      id: row.id, type: "qweather", name: row.name, revision: row.revision, settings: {}, configured,
      apiHost: settings.apiHost, authMode: settings.authMode, apiVersion: settings.apiVersion, credentialConfigured: configured
    };
  }

  listWeather(): WeatherConnection[] {
    return this.listType("qweather").flatMap((connection) => {
      const weather = this.getWeatherPublic(connection.id, connection.revision);
      return weather ? [weather] : [];
    });
  }

  /** Internal, server-only connection projection. It contains only a secret id. */
  weather(id: string, revision: number): QWeatherConnection | undefined {
    const row = this.getRaw(id, revision);
    if (!row || row.type !== "qweather") return undefined;
    const settings = parseWeatherSettings(row.settings);
    if (!settings || !this.credentials.has(id, settings.credentialId)) return undefined;
    return {
      id, revision, type: "qweather", apiHost: settings.apiHost, authMode: settings.authMode,
      apiVersion: settings.apiVersion, secretRef: settings.credentialId, authRevision: settings.authRevision, identity: settings.identity
    };
  }

  async readWeather(config: WeatherConfig, now: string, force = false): Promise<{ envelope: WeatherEnvelope; cache?: WeatherCacheEntry }> {
    const connection = this.weather(config.connectionId, config.connectionRevision);
    if (!connection) return { envelope: { status: "unavailable", reason: config.connectionId ? "connection" : "missing" } };
    const key = JSON.stringify([connection.id, connection.revision, config.locationMode, config.city, config.latitude, config.longitude, config.units, config.showForecast, connection.authRevision, connection.identity]);
    if (!force) {
      const active = this.weatherPending.get(key);
      if (active) return active;
    }
    const cached = force ? undefined : this.weatherCache.get(key) ?? this.readPersistedWeatherCache(key);
    const task = collectWeather({
      config,
      connection,
      now,
      cache: cached,
      transport: this.weatherTransport ?? (async () => { throw new Error("weather_transport_unavailable"); })
    }).then((result) => {
      if (result.cache) {
        this.weatherCache.set(key, result.cache);
        this.db.prepare("INSERT INTO weather_cache(cache_key,connection_id,connection_revision,auth_revision,fetched_at,snapshot) VALUES (?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET connection_revision=excluded.connection_revision,auth_revision=excluded.auth_revision,fetched_at=excluded.fetched_at,snapshot=excluded.snapshot").run(key, connection.id, connection.revision, connection.authRevision, result.cache.fetchedAt, JSON.stringify(result.cache.snapshot));
      }
      return result;
    }).finally(() => this.weatherPending.delete(key));
    this.weatherPending.set(key, task);
    return task;
  }

  /** Tests an unsaved connection entirely in memory; it never touches the
   * connections, credentials, weather_cache, dashboard, or job tables. */
  async testWeather(config: WeatherConfig, input?: WeatherConnectionInput): Promise<WeatherEnvelope> {
    const checked = validateWidgetInstanceConfig({ type: "weather", configVersion: 1, config: { ...config } });
    if (!checked.ok) return { status: "unavailable", reason: "response" };
    const now = new Date().toISOString();
    if (!input) return (await this.readWeather(config, now, true)).envelope;
    if (!validWeatherHost(input.apiHost) || !input.apiKey.trim() || input.apiKey.length > 8192) return { status: "unavailable", reason: "connection" };
    const testId = "weather-test";
    const secretRef = `qweather:${testId}:${randomBytes(12).toString("hex")}`;
    const transport = this.weatherTestTransport ?? new QWeatherHttpClient((owner) => owner === testId ? input.apiKey : undefined).transport;
    const connection: QWeatherConnection = {
      id: testId, revision: 1, type: "qweather", apiHost: input.apiHost.toLowerCase(), authMode: input.authMode,
      apiVersion: "v1", secretRef, authRevision: 1, identity: "ephemeral-test"
    };
    return (await collectWeather({ config: { ...config, connectionId: testId, connectionRevision: 1 }, connection, now, transport })).envelope;
  }

  validate(dashboard: DashboardDraft): void {
    for (const widget of dashboard.widgets) {
      if (widget.type === "codex-usage") {
        const { connectionId, connectionRevision } = widget.config;
        const connection = connectionId ? this.get(String(connectionId), Number(connectionRevision)) : undefined;
        if (connectionId && (!connection || connection.type !== "codex-local")) throw new Error("connection_reference_invalid");
      }
      if (widget.type === "weather") {
        const { connectionId, connectionRevision } = widget.config;
        if (connectionId && !this.getWeatherPublic(String(connectionId), Number(connectionRevision))) throw new Error("connection_reference_invalid");
      }
      if (widget.type === "calendar") {
        const { connectionId, connectionRevision } = widget.config;
        const connection = connectionId ? this.get(String(connectionId), Number(connectionRevision)) : undefined;
        if (connectionId && (!connection || connection.type !== "google-calendar-oauth")) throw new Error("connection_reference_invalid");
      }
    }
  }

  remove(id: string, dashboards: DashboardDraft[]): void {
    if (dashboards.some((dashboard) => dashboard.widgets.some((widget) => widget.config.connectionId === id))) throw new Error("connection_in_use");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM weather_cache WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM credentials WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM connection_versions WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM connections WHERE id=?").run(id);
    })();
    this.invalidate(id);
  }

  invalidate(_connection?: string): void {
    this.cached = undefined;
    this.lastGood = undefined;
    this.cacheAt = 0;
    this.weatherCache.clear();
  }

  previous(): CodexLimitsResult | undefined { return this.lastGood; }

  latest(): { status: CodexLimitsResult["status"]; observedAt: string; error?: string } | null {
    return this.cached ? { status: this.cached.status, observedAt: this.cached.observedAt, error: this.cached.error } : null;
  }

  groups(result = this.cached): { id: string; name: string }[] {
    const raw = result?.raw;
    if (raw?.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length) return Object.entries(raw.rateLimitsByLimitId).map(([id, bucket]) => ({ id, name: bucket.limitName ?? id }));
    return raw?.rateLimits ? [{ id: raw.rateLimits.limitId || "default", name: raw.rateLimits.limitName ?? "默认额度" }] : [];
  }

  async read(force = false): Promise<CodexLimitsResult> {
    if (this.pending) return this.pending;
    if (this.cached && Date.now() - this.cacheAt < (force ? 15_000 : 600_000)) return this.cached;
    this.pending = this.reader().then((result) => {
      if (result.status === "ok") this.lastGood = result;
      else if (["not_logged_in", "unsupported_auth"].includes(result.status) || (result.identity && this.lastGood?.identity !== result.identity)) this.lastGood = undefined;
      this.cached = result;
      this.cacheAt = Date.now();
      return result;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private getLatest(id: string): Connection | undefined {
    const row = this.db.prepare("SELECT c.id,c.type,c.name,MAX(v.revision) AS revision,v.settings FROM connections c JOIN connection_versions v ON c.id=v.connection_id WHERE c.id=? GROUP BY c.id,c.type,c.name").get(id) as { id: string; type: ConnectionType; name: string; revision: number; settings: string } | undefined;
    return row ? this.publicConnection(row) : undefined;
  }

  private getRaw(id: string, revision: number): { id: string; type: ConnectionType; name: string; revision: number; settings: string } | undefined {
    return this.db.prepare("SELECT c.id,c.type,c.name,v.revision,v.settings FROM connections c JOIN connection_versions v ON c.id=v.connection_id WHERE c.id=? AND v.revision=?").get(id, revision) as { id: string; type: ConnectionType; name: string; revision: number; settings: string } | undefined;
  }

  private getWeatherSettings(id: string, revision: number): { row: { id: string; type: ConnectionType; name: string; revision: number; settings: string }; settings: WeatherSettings } | undefined {
    const row = this.getRaw(id, revision);
    const settings = row ? parseWeatherSettings(row.settings) : undefined;
    return row && row.type === "qweather" && settings ? { row, settings } : undefined;
  }

  private publicConnection(row: { id: string; type: ConnectionType; name: string; revision: number; settings: string }): Connection {
    if (row.type === "qweather") {
      const weather = this.getWeatherPublic(row.id, row.revision);
      if (weather) return weather;
    }
    return { id: row.id, type: row.type, name: row.name, revision: row.revision, settings: {}, configured: row.type === "codex-local" };
  }

  private readPersistedWeatherCache(key: string): WeatherCacheEntry | undefined {
    const row = this.db.prepare("SELECT fetched_at,snapshot FROM weather_cache WHERE cache_key=?").get(key) as { fetched_at: string; snapshot: string } | undefined;
    if (!row) return undefined;
    try {
      const snapshot = JSON.parse(row.snapshot) as WeatherCacheEntry["snapshot"];
      if (!snapshot || typeof snapshot !== "object") return undefined;
      return { key, fetchedAt: row.fetched_at, snapshot };
    } catch { return undefined; }
  }
}

function validWeatherHost(value: string): boolean {
  return /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)+qweatherapi\.com$/i.test(value) && value.length <= 253;
}

function parseWeatherSettings(value: string): WeatherSettings | undefined {
  try {
    const settings = JSON.parse(value) as Partial<WeatherSettings>;
    if (!settings.apiHost || !validWeatherHost(settings.apiHost) || !settings.credentialId || !settings.authRevision || !settings.identity) return undefined;
    return { apiHost: settings.apiHost, authMode: settings.authMode === "jwt" ? "jwt" : "api-key", apiVersion: settings.apiVersion === "v7" ? "v7" : "v1", credentialId: settings.credentialId, authRevision: settings.authRevision, identity: settings.identity };
  } catch { return undefined; }
}

function hashIdentity(id: string, revision: number, authRevision: number): string {
  return createHash("sha256").update(`${id}:${revision}:${authRevision}`).digest("hex").slice(0, 16);
}
