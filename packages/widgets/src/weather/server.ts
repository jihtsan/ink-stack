// Server-only entry: never export this module from catalog.ts or render.ts.
import { validateWeatherConfig } from "../generated/config-validators.js";
import { normalizeWeatherLocation, normalizeWeatherLocations, normalizeWeatherSnapshot, qweatherResponseError, timestamp, weatherEnvelope } from "./normalize.js";
import type { WeatherConfig, WeatherEnvelope, WeatherError, WeatherLocation, WeatherSnapshot } from "./types.js";

export interface QWeatherConnection {
  id: string;
  revision: number;
  type: "qweather";
  apiHost: string;
  authMode: "jwt" | "api-key";
  secretRef: string;
  /** New v1 coordinates API. Missing means the legacy v7 fixture contract. */
  apiVersion?: "v1" | "v7";
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
    && (connection.apiVersion === undefined || ["v1", "v7"].includes(connection.apiVersion))
    && Number.isInteger(connection.authRevision) && connection.authRevision >= 1;
}

export function weatherCacheKey(config: WeatherConfig, connection: QWeatherConnection): string {
  return JSON.stringify([
    "qweather-v1", connection.id, connection.revision, connection.authRevision, connection.identity,
    connection.apiHost, connection.authMode, connection.secretRef, connection.apiVersion ?? "v7", config.locationMode,
    config.locationMode === "city" ? [config.locationId ?? null, config.city.trim(), config.longitude, config.latitude] : [config.longitude, config.latitude],
    config.units, config.showForecast, config.forecastMode ?? "daily"
  ]);
}

/** Search GeoAPI without persisting the query or returning provider-only fields. */
export async function lookupWeatherLocations(options: {
  connection?: QWeatherConnection;
  query: string;
  transport: QWeatherTransport;
  timeoutMs?: number;
}): Promise<{ locations: WeatherLocation[]; error?: WeatherError }> {
  const query = options.query.trim();
  if (!options.connection || !validQWeatherConnection(options.connection) || !query || query.length > 80) {
    return { locations: [], error: "connection" };
  }
  const timeoutMs = Math.max(100, Math.min(15_000, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 8_000));
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new WeatherFetchError("timeout")); }, timeoutMs);
  });
  try {
    const url = new URL(`https://${options.connection.apiHost}/geo/v2/city/lookup`);
    url.search = new URLSearchParams({ location: query, number: "20", lang: "zh" }).toString();
    const response = await Promise.race([deadline, options.transport({
      url: url.href,
      method: "GET",
      redirect: "error",
      timeoutMs,
      maxResponseBytes: 262_144,
      signal: controller.signal,
      authentication: {
        secretRef: options.connection.secretRef,
        header: options.connection.authMode === "jwt" ? "Authorization" : "X-QW-Api-Key",
        prefix: options.connection.authMode === "jwt" ? "Bearer " : ""
      }
    })]);
    const error = qweatherResponseError(response);
    return error ? { locations: [], error } : { locations: normalizeWeatherLocations(response) };
  } catch (error) {
    return { locations: [], error: error instanceof WeatherFetchError ? error.category : "network" };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
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
      let coordinates = { latitude: config.latitude, longitude: config.longitude };
      const selectedLocationId = typeof config.locationId === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(config.locationId)
        ? config.locationId
        : undefined;
      if (selectedLocationId) {
        location = selectedLocationId;
        locationName = config.city.trim() || selectedLocationId;
      } else if (config.locationMode === "city") {
        const result = normalizeWeatherLocation(await request("/geo/v2/city/lookup", { location: config.city.trim(), number: "20" }));
        if (!result) throw new WeatherFetchError("location");
        location = result.id;
        locationName = result.name;
        if (result.latitude !== undefined && result.longitude !== undefined) {
          coordinates = { latitude: result.latitude, longitude: result.longitude };
        }
      }
      const isV1 = connection.apiVersion === "v1";
      const current = isV1
        ? await request(`/weather/v1/current/${coordinates.latitude.toFixed(2)}/${coordinates.longitude.toFixed(2)}`, { localTime: "true" })
        : await request("/v7/weather/now", { location, unit: config.units });
      // A failed optional secondary request must not erase a valid current observation.
      let daily: unknown;
      let hourly: unknown;
      let airQuality: unknown;
      let secondaryError: WeatherError | undefined;
      if (config.showForecast) {
        try {
          switch (config.forecastMode ?? "daily") {
            case "hourly":
              hourly = isV1
                ? await request(`/weather/v1/hourly/${coordinates.latitude.toFixed(2)}/${coordinates.longitude.toFixed(2)}`, { hours: "12", localTime: "true" })
                : await request("/v7/weather/24h", { location, unit: config.units });
              break;
            case "air-quality":
              airQuality = await request(`/airquality/v1/current/${coordinates.latitude.toFixed(2)}/${coordinates.longitude.toFixed(2)}`, {});
              break;
            default:
              daily = isV1
                ? await request(`/weather/v1/daily/${coordinates.latitude.toFixed(2)}/${coordinates.longitude.toFixed(2)}`, { days: "3", localTime: "true" })
                : await request("/v7/weather/3d", { location, unit: config.units });
          }
        }
        catch (error) { secondaryError = error instanceof WeatherFetchError ? error.category : "network"; }
      }
      const normalized = normalizeWeatherSnapshot(current, daily, {
        location: locationName, units: config.units, apiVersion: isV1 ? "v1" : "v7", observedAtFallback: now, hourly, airQuality
      });
      if (!normalized || Date.parse(normalized.observedAt) > Date.parse(now)) throw new WeatherFetchError("response");
      if (secondaryError) {
        switch (config.forecastMode ?? "daily") {
          case "hourly": normalized.hourlyError = secondaryError; break;
          case "air-quality": normalized.airQualityError = secondaryError; break;
          default: normalized.forecastError = secondaryError;
        }
      }
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
