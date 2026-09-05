// Server-only entry: never export this module from catalog.ts or render.ts.
import { validateWeatherConfig } from "../generated/config-validators.js";
import { normalizeWeatherLocation, normalizeWeatherSnapshot, qweatherResponseError, timestamp, weatherEnvelope } from "./normalize.js";
import type { WeatherConfig, WeatherEnvelope, WeatherError, WeatherSnapshot } from "./types.js";

export interface QWeatherConnection {
  id: string;
  revision: number;
  type: "qweather";
  apiHost: string;
  authMode: "jwt" | "api-key";
  secretRef: string;
  /** Both must change/invalidate caches when credentials or provider identity change. */
  authRevision: number;
  identity: string;
}

export interface QWeatherRequest {
  url: string;
  method: "GET";
  authentication: { secretRef: string; header: "Authorization" | "X-QW-Api-Key"; prefix: "Bearer " | "" };
  redirect: "error";
  timeoutMs: number;
  maxResponseBytes: number;
  signal: AbortSignal;
}

/** Trusted server transport resolves secrets only at request time. It must enforce DNS/IP
 * pinning, reject private/reserved targets, bound decoded response bytes, and never log
 * headers or raw upstream errors. Return JSON only; resolve HTTP errors to {code: status}.
 * Missing/undecryptable secrets must fail closed. JWT signing/refresh belongs here. */
export type QWeatherTransport = (request: QWeatherRequest) => Promise<unknown>;

export interface WeatherCacheEntry {
  key: string;
  fetchedAt: string;
  snapshot: WeatherSnapshot;
}

class WeatherFetchError extends Error {
  constructor(readonly category: WeatherError) { super(category); }
}

export function validQWeatherConnection(connection: QWeatherConnection): boolean {
  return connection.type === "qweather"
    && /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)+qweatherapi\.com$/.test(connection.apiHost)
    && connection.apiHost.length <= 253
    && ["jwt", "api-key"].includes(connection.authMode)
    && typeof connection.secretRef === "string" && connection.secretRef.trim().length > 0
    && typeof connection.identity === "string" && connection.identity.trim().length > 0
    && Number.isInteger(connection.authRevision) && connection.authRevision >= 1;
}

export function weatherCacheKey(config: WeatherConfig, connection: QWeatherConnection): string {
  return JSON.stringify([
    "qweather-v1", connection.id, connection.revision, connection.authRevision, connection.identity,
    connection.apiHost, connection.authMode, connection.secretRef, config.locationMode,
    config.locationMode === "city" ? config.city.trim() : [config.longitude, config.latitude],
    config.units, config.showForecast
  ]);
}

/** One scheduled collection. Caller persists/reuses cache and coalesces identical keys.
 * Device PNG GET handlers must never call this function. No global clock or cache. */
export async function collectWeather(options: {
  config: WeatherConfig;
  connection?: QWeatherConnection;
  now: string;
  transport: QWeatherTransport;
  cache?: WeatherCacheEntry;
  timeoutMs?: number;
}): Promise<{ envelope: WeatherEnvelope; cache?: WeatherCacheEntry }> {
  const { config, connection, transport, cache } = options;
  const now = timestamp(options.now);
  if (!validateWeatherConfig(config) || !now || !connection || !validQWeatherConnection(connection)
    || connection.id !== config.connectionId || connection.revision !== config.connectionRevision) {
    return { envelope: { status: "unavailable", reason: "connection" } };
  }
  const key = weatherCacheKey(config, connection);
  const previous = cache?.key === key && cache.snapshot.units === config.units ? cache : undefined;
  const cached = weatherEnvelope(previous?.snapshot, config, now);
  const elapsed = previous ? Date.parse(now) - Date.parse(previous.fetchedAt) : Infinity;
  if (previous && cached.status === "fresh" && elapsed >= 0 && elapsed < config.refreshSeconds * 1000) {
    return { envelope: cached, cache: previous };
  }
  const timeoutMs = Math.max(100, Math.min(15000, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 8000));
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new WeatherFetchError("timeout")); }, timeoutMs);
  });
  async function request(path: string, params: Record<string, string>): Promise<unknown> {
    if (controller.signal.aborted) throw new WeatherFetchError("timeout");
    const url = new URL(`https://${connection!.apiHost}${path}`);
    url.search = new URLSearchParams({ ...params, lang: "zh" }).toString();
    const response = await transport({
      url: url.href, method: "GET", redirect: "error", timeoutMs, maxResponseBytes: 262144, signal: controller.signal,
      authentication: {
        secretRef: connection!.secretRef,
        header: connection!.authMode === "jwt" ? "Authorization" : "X-QW-Api-Key",
        prefix: connection!.authMode === "jwt" ? "Bearer " : ""
      }
    });
    if (controller.signal.aborted) throw new WeatherFetchError("timeout");
    const error = qweatherResponseError(response);
    if (error) throw new WeatherFetchError(error);
    return response;
  }
  try {
    const snapshot = await Promise.race([deadline, (async () => {
      let location = `${config.longitude.toFixed(2)},${config.latitude.toFixed(2)}`;
      let locationName = location;
      if (config.locationMode === "city") {
        const result = normalizeWeatherLocation(await request("/geo/v2/city/lookup", { location: config.city.trim(), number: "20" }));
        if (!result) throw new WeatherFetchError("location");
        location = result.id;
        locationName = result.name;
      }
      const current = await request("/v7/weather/now", { location, unit: config.units });
      // A failed optional forecast must not erase a valid current observation.
      let daily: unknown;
      let forecastError: WeatherError | undefined;
      if (config.showForecast) {
        try { daily = await request("/v7/weather/3d", { location, unit: config.units }); }
        catch (error) { forecastError = error instanceof WeatherFetchError ? error.category : "network"; }
      }
      const normalized = normalizeWeatherSnapshot(current, daily, { location: locationName, units: config.units });
      if (!normalized || Date.parse(normalized.observedAt) > Date.parse(now)) throw new WeatherFetchError("response");
      if (forecastError) normalized.forecastError = forecastError;
      return normalized;
    })()]);
    const envelope = weatherEnvelope(snapshot, config, now);
    const next = envelope.data ? { key, fetchedAt: now, snapshot } : undefined;
    // A regressing upstream observation must not displace a newer valid cache.
    if (previous && Date.parse(previous.snapshot.observedAt) > Date.parse(snapshot.observedAt)) {
      return { envelope: weatherEnvelope(previous.snapshot, config, now, "response"), cache: previous };
    }
    return { envelope, cache: next };
  } catch (error) {
    const failure = error instanceof WeatherFetchError ? error.category : "network";
    return { envelope: weatherEnvelope(previous?.snapshot, config, now, failure), cache: previous };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
