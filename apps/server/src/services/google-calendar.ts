import { randomBytes, randomUUID } from "node:crypto";
import type { DashboardDraft } from "@ink-stack/shared";
import { CalendarAdapterError, normalizeGoogleEvents, type CalendarAdapter, type CalendarReadRequest, type CalendarSnapshot } from "@ink-stack/widgets/calendar/server";
import type { InkDatabase } from "../storage/database.js";
import { digest } from "../auth.js";
import type { Connections } from "../data/connections.js";

const calendarScope = "https://www.googleapis.com/auth/calendar.readonly";
const calendarListScope = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const revokeEndpoint = "https://oauth2.googleapis.com/revoke";
const authEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const calendarApiOrigin = "https://www.googleapis.com";
const appConnectionId = "google-oauth-app";
const appCredentialId = "google:app:client-secret";

export type GoogleHttpRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};

export type GoogleHttpResponse = { status: number; body: unknown };
export type GoogleHttp = (request: GoogleHttpRequest) => Promise<GoogleHttpResponse>;

export type GoogleAppStatus = { configured: boolean; clientId?: string };
export type GoogleCalendarConnection = {
  id: string;
  type: "google-calendar-oauth";
  name: string;
  revision: number;
  configured: boolean;
  accountLabel: string;
};
export type GoogleCalendarInfo = { id: string; summary: string; primary: boolean; timeZone?: string };

interface GoogleTokenResponse { access_token: string; expires_in?: number; refresh_token?: string; scope?: string; token_type?: string }
interface GoogleSettings { refreshCredentialId: string; accessCredentialId: string; accessExpiresAt: string; scope: string; identity: string }
interface ConnectionRow { id: string; type: string; name: string; revision: number; settings: string }

export class GoogleCalendarService implements CalendarAdapter {
  private readonly http: GoogleHttp;
  private readonly now: () => Date;

  constructor(private readonly db: InkDatabase, private readonly connections: Connections, options: { http?: GoogleHttp; now?: () => Date } = {}) {
    this.http = options.http ?? defaultGoogleHttp;
    this.now = options.now ?? (() => new Date());
    db.prepare("INSERT OR IGNORE INTO connections VALUES (?,?,?)").run(appConnectionId, "google-oauth-app", "Google OAuth 应用");
    db.prepare("INSERT OR IGNORE INTO connection_versions VALUES (?,?,?)").run(appConnectionId, 1, JSON.stringify({}));
  }

  appStatus(): GoogleAppStatus {
    const row = this.db.prepare("SELECT client_id,credential_id FROM google_oauth_app WHERE id=1").get() as { client_id: string; credential_id: string } | undefined;
    return row ? { configured: this.connections.credentials.has(appConnectionId, row.credential_id), clientId: row.client_id } : { configured: false };
  }

  setApp(clientId: string, clientSecret: string): GoogleAppStatus {
    const id = clientId.trim();
    if (!/^[\x21-\x7e]{8,256}$/.test(id) || !clientSecret || clientSecret.length > 8192) throw new Error("invalid_google_app");
    this.connections.credentials.write(appConnectionId, appCredentialId, { action: "replace", value: clientSecret });
    this.db.prepare("INSERT INTO google_oauth_app(id,client_id,credential_id,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,credential_id=excluded.credential_id,updated_at=excluded.updated_at")
      .run(id, appCredentialId, this.now().toISOString());
    return this.appStatus();
  }

  async start(sessionHash: string, origin: string): Promise<string> {
    const app = this.appConfig();
    const state = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at<?").run(now.toISOString());
    this.db.prepare("INSERT INTO oauth_states(state_hash,session_hash,created_at,expires_at) VALUES (?,?,?,?)")
      .run(digest(state), sessionHash, now.toISOString(), new Date(now.getTime() + 10 * 60_000).toISOString());
    const redirectUri = `${origin.replace(/\/$/, "")}/api/google/oauth/callback`;
    const url = new URL(authEndpoint);
    url.search = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `${calendarScope} ${calendarListScope}`,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state
    }).toString();
    return url.href;
  }

  async complete(sessionHash: string, state: string, code: string, origin: string): Promise<GoogleCalendarConnection> {
    if (!state || state.length > 512 || !code || code.length > 8192) throw new Error("oauth_state_invalid");
    const stateHash = digest(state);
    const row = this.db.prepare("SELECT session_hash,expires_at FROM oauth_states WHERE state_hash=?").get(stateHash) as { session_hash: string; expires_at: string } | undefined;
    this.db.prepare("DELETE FROM oauth_states WHERE state_hash=?").run(stateHash);
    if (!row || row.session_hash !== sessionHash || Date.parse(row.expires_at) <= this.now().getTime()) throw new Error("oauth_state_invalid");
    const app = this.appConfig();
    const redirectUri = `${origin.replace(/\/$/, "")}/api/google/oauth/callback`;
    const response = await this.http({
      url: tokenEndpoint, method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString()
    });
    const token = tokenResponse(response.body);
    if (response.status < 200 || response.status >= 300 || !token?.access_token || !token.refresh_token) throw new Error("oauth_exchange_failed");
    const id = randomUUID();
    const refreshCredentialId = `google:${id}:refresh`;
    const accessCredentialId = `google:${id}:access`;
    const settings: GoogleSettings = {
      refreshCredentialId, accessCredentialId,
      accessExpiresAt: new Date(this.now().getTime() + Math.max(60, Math.min(86_400, token.expires_in ?? 3600)) * 1000).toISOString(),
      scope: token.scope ?? `${calendarScope} ${calendarListScope}`,
      identity: digest(`${id}:${sessionHash}`).slice(0, 16)
    };
    try {
      this.db.transaction(() => {
        this.db.prepare("INSERT INTO connections VALUES (?,?,?)").run(id, "google-calendar-oauth", "Google Calendar");
        this.db.prepare("INSERT INTO connection_versions VALUES (?,?,?)").run(id, 1, JSON.stringify(settings));
        this.connections.credentials.write(id, refreshCredentialId, { action: "replace", value: token.refresh_token! });
        this.connections.credentials.write(id, accessCredentialId, { action: "replace", value: token.access_token });
      })();
    } catch (error) {
      this.db.prepare("DELETE FROM connections WHERE id=?").run(id);
      throw error;
    }
    return this.publicConnection({ id, type: "google-calendar-oauth", name: "Google Calendar", revision: 1, settings: JSON.stringify(settings) });
  }

  listConnections(): GoogleCalendarConnection[] {
    const rows = this.db.prepare("SELECT c.id,c.type,c.name,v.revision,v.settings FROM connections c JOIN connection_versions v ON c.id=v.connection_id WHERE c.type='google-calendar-oauth' AND v.revision=(SELECT MAX(v2.revision) FROM connection_versions v2 WHERE v2.connection_id=c.id) ORDER BY c.name,c.id").all() as ConnectionRow[];
    return rows.flatMap((row) => this.parseSettings(row.settings) ? [this.publicConnection(row)] : []);
  }

  async listCalendars(id: string, revision: number): Promise<GoogleCalendarInfo[]> {
    const token = await this.accessToken(id, revision);
    const items = await this.pages("/calendar/v3/users/me/calendarList", token, "items", 250);
    return items.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      if (typeof value.id !== "string" || !value.id || value.id.length > 256) return [];
      return [{ id: value.id, summary: typeof value.summaryOverride === "string" && value.summaryOverride ? value.summaryOverride.slice(0, 200) : typeof value.summary === "string" ? value.summary.slice(0, 200) : value.id, primary: value.primary === true, timeZone: typeof value.timeZone === "string" ? value.timeZone.slice(0, 80) : undefined }];
    });
  }

  async read(request: CalendarReadRequest, signal: AbortSignal): Promise<CalendarSnapshot & { observedAt: string }> {
    const token = await this.accessToken(request.connectionId, request.connectionRevision, signal);
    const events: ReturnType<typeof normalizeGoogleEvents> = [];
    let truncated = false;
    for (const calendarId of request.calendarIds.slice(0, 5)) {
      const start = zonedMidnight(request.startDate, request.timeZone);
      const end = zonedMidnight(request.endDate, request.timeZone);
      const pages = await this.pages(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, token, "items", 100, {
        singleEvents: "true", orderBy: "startTime", showDeleted: "false", timeMin: start, timeMax: end
      }, signal);
      events.push(...normalizeGoogleEvents(calendarId, pages));
      if (pages.length >= 100) truncated = true;
      if (events.length >= 500) { truncated = true; break; }
    }
    // The calendar collector's context timestamp is captured before the
    // adapter starts. Subtract a small bound so a successful request cannot
    // appear to come from the future due to request latency.
    return { source: "google", observedAt: new Date(this.now().getTime() - 1000).toISOString(), events: events.slice(0, 500), truncated };
  }

  async remove(id: string, dashboards: DashboardDraft[]): Promise<void> {
    if (dashboards.some((dashboard) => dashboard.widgets.some((widget) => widget.type === "calendar" && widget.config.connectionId === id))) throw new Error("connection_in_use");
    const row = this.getConnection(id);
    if (!row) throw new Error("connection_not_found");
    const settings = this.parseSettings(row.settings);
    if (!settings) throw new Error("connection_not_found");
    const refresh = this.connections.credentials.read(id, settings.refreshCredentialId);
    if (refresh) {
      await this.http({ url: revokeEndpoint, method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }).toString() }).catch(() => undefined);
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM credentials WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM connection_versions WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM connections WHERE id=?").run(id);
    })();
  }

  private async accessToken(id: string, revision: number, signal: AbortSignal = AbortSignal.timeout(8000)): Promise<string> {
    const row = this.getConnection(id, revision);
    const settings = row ? this.parseSettings(row.settings) : undefined;
    if (!row || row.type !== "google-calendar-oauth" || !settings) throw new CalendarAdapterError("unauthenticated");
    const access = this.connections.credentials.read(id, settings.accessCredentialId);
    if (access && Date.parse(settings.accessExpiresAt) > this.now().getTime() + 60_000) return access;
    const refresh = this.connections.credentials.read(id, settings.refreshCredentialId);
    if (!refresh) throw new CalendarAdapterError("unauthenticated");
    const app = this.appConfig();
    const response = await this.http({
      url: tokenEndpoint, method: "POST", signal,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, refresh_token: refresh, grant_type: "refresh_token" }).toString()
    });
    const token = tokenResponse(response.body);
    if (response.status < 200 || response.status >= 300 || !token?.access_token) throw new CalendarAdapterError("unauthenticated");
    this.connections.credentials.write(id, settings.accessCredentialId, { action: "replace", value: token.access_token });
    const next = { ...settings, accessExpiresAt: new Date(this.now().getTime() + Math.max(60, Math.min(86_400, token.expires_in ?? 3600)) * 1000).toISOString() };
    this.db.prepare("UPDATE connection_versions SET settings=? WHERE connection_id=? AND revision=?").run(JSON.stringify(next), id, revision);
    return token.access_token;
  }

  private async pages(path: string, token: string, itemsKey: string, maxResults: number, params: Record<string, string> = {}, signal: AbortSignal = AbortSignal.timeout(8000)): Promise<unknown[]> {
    const all: unknown[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const url = new URL(path, calendarApiOrigin);
      url.search = new URLSearchParams({ ...params, maxResults: String(maxResults), ...(pageToken ? { pageToken } : {}) }).toString();
      const response = await this.http({ url: url.href, method: "GET", signal, headers: { accept: "application/json", authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) throw new CalendarAdapterError("unauthenticated");
      if (response.status < 200 || response.status >= 300) throw new CalendarAdapterError("unavailable");
      const body = response.body && typeof response.body === "object" && !Array.isArray(response.body) ? response.body as Record<string, unknown> : {};
      const pageItems = body[itemsKey];
      if (!Array.isArray(pageItems)) throw new CalendarAdapterError("unavailable");
      all.push(...pageItems);
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken.length <= 1024 ? body.nextPageToken : undefined;
      if (!pageToken || all.length >= 500) break;
    }
    return all.slice(0, 500);
  }

  private appConfig(): { clientId: string; clientSecret: string } {
    const row = this.db.prepare("SELECT client_id,credential_id FROM google_oauth_app WHERE id=1").get() as { client_id: string; credential_id: string } | undefined;
    if (!row) throw new Error("google_app_not_configured");
    const secret = this.connections.credentials.read(appConnectionId, row.credential_id);
    if (!secret) throw new Error("google_app_not_configured");
    return { clientId: row.client_id, clientSecret: secret };
  }

  private getConnection(id: string, revision?: number): ConnectionRow | undefined {
    return (revision === undefined
      ? this.db.prepare("SELECT c.id,c.type,c.name,v.revision,v.settings FROM connections c JOIN connection_versions v ON c.id=v.connection_id WHERE c.id=? ORDER BY v.revision DESC LIMIT 1").get(id)
      : this.db.prepare("SELECT c.id,c.type,c.name,v.revision,v.settings FROM connections c JOIN connection_versions v ON c.id=v.connection_id WHERE c.id=? AND v.revision=?").get(id, revision)) as ConnectionRow | undefined;
  }

  private parseSettings(value: string): GoogleSettings | undefined {
    try {
      const settings = JSON.parse(value) as Partial<GoogleSettings>;
      return typeof settings.refreshCredentialId === "string" && typeof settings.accessCredentialId === "string" && typeof settings.accessExpiresAt === "string" && typeof settings.scope === "string" && typeof settings.identity === "string" ? settings as GoogleSettings : undefined;
    } catch { return undefined; }
  }

  private publicConnection(row: ConnectionRow): GoogleCalendarConnection {
    return { id: row.id, type: "google-calendar-oauth", name: row.name, revision: row.revision, configured: Boolean(this.parseSettings(row.settings)), accountLabel: row.name };
  }
}

function tokenResponse(value: unknown): GoogleTokenResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  return typeof body.access_token === "string" && body.access_token.length <= 8192
    ? { access_token: body.access_token, expires_in: typeof body.expires_in === "number" ? body.expires_in : undefined, refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined, scope: typeof body.scope === "string" ? body.scope.slice(0, 512) : undefined, token_type: typeof body.token_type === "string" ? body.token_type : undefined }
    : undefined;
}

async function defaultGoogleHttp(request: GoogleHttpRequest): Promise<GoogleHttpResponse> {
  const url = new URL(request.url);
  const allowed = url.origin === "https://oauth2.googleapis.com" || url.origin === "https://www.googleapis.com" || url.origin === "https://accounts.google.com";
  if (!allowed || request.method === "GET" && url.origin === "https://accounts.google.com") throw new Error("google_target_not_allowed");
  const response = await fetch(url, { method: request.method, headers: request.headers, body: request.body, redirect: "error", signal: request.signal });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 512 * 1024) throw new Error("google_response_too_large");
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = {}; }
  return { status: response.status, body };
}

function zonedMidnight(date: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new CalendarAdapterError("unavailable");
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let instant = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const localAsUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    instant -= localAsUtc - target;
  }
  return new Date(instant).toISOString();
}
