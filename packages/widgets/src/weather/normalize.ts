import type { WeatherConfig, WeatherEnvelope, WeatherError, WeatherSnapshot } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown, minimum = -200, maximum = 200): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function label(value: unknown): string {
  return typeof value === "string" ? [...value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()].slice(0, 80).join("") : "";
}

export function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function qweatherResponseError(value: unknown): WeatherError | undefined {
  const code = String(record(value).code ?? "");
  if (code === "200") return undefined;
  if (code === "401" || code === "403") return "authentication";
  if (code === "404") return "location";
  return "response";
}

/** Choose only an unambiguous location. Never silently select the first same-name city. */
export function normalizeWeatherLocation(value: unknown): { id: string; name: string } | undefined {
  const body = record(value);
  if (qweatherResponseError(body) || !Array.isArray(body.location) || body.location.length !== 1) return undefined;
  const item = record(body.location[0]);
  return typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(item.id) && label(item.name)
    ? { id: item.id, name: label(item.name) } : undefined;
}

/** Select known fields, preserve missing values, and reject incomplete current observations. */
export function normalizeWeatherSnapshot(
  current: unknown,
  daily: unknown,
  options: { location: string; units: "m" | "i" }
): WeatherSnapshot | undefined {
  const body = record(current);
  if (qweatherResponseError(body)) return undefined;
  const now = record(body.now);
  const temperature = number(now.temp);
  const observedAt = timestamp(now.obsTime);
  const condition = label(now.text);
  if (temperature === undefined || !observedAt || !condition) return undefined;
  const forecastBody = record(daily);
  const forecast: WeatherSnapshot["forecast"] = [];
  if (!qweatherResponseError(forecastBody) && Array.isArray(forecastBody.daily)) {
    for (const raw of forecastBody.daily.slice(0, 3)) {
      const day = record(raw);
      const minimum = number(day.tempMin);
      const maximum = number(day.tempMax);
      if (typeof day.fxDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.fxDate)
        || !Number.isFinite(Date.parse(day.fxDate)) || minimum === undefined || maximum === undefined || minimum > maximum) continue;
      if (forecast.some((item) => item.date === day.fxDate)) continue;
      forecast.push({ date: day.fxDate, minimum, maximum, condition: label(day.textDay) });
    }
    forecast.sort((a, b) => a.date.localeCompare(b.date));
  }
  return {
    location: label(options.location), units: options.units, observedAt, temperature, condition,
    feelsLike: number(now.feelsLike), humidity: number(now.humidity, 0, 100), windSpeed: number(now.windSpeed, 0, 1000), forecast
  };
}

/** Ages are measured from observation time, never from the latest failed fetch. */
export function weatherEnvelope(
  snapshot: WeatherSnapshot | undefined,
  config: Pick<WeatherConfig, "cacheTtlSeconds" | "maxStaleSeconds">,
  now: string,
  failure?: WeatherError
): WeatherEnvelope {
  const currentTime = Date.parse(now);
  const observation = snapshot ? Date.parse(snapshot.observedAt) : NaN;
  const age = currentTime - observation;
  if (!snapshot || !Number.isFinite(age) || age < 0) {
    return { status: failure === "authentication" ? "unauthenticated" : "unavailable", reason: failure ?? "missing" };
  }
  if (age > (config.cacheTtlSeconds + config.maxStaleSeconds) * 1000) {
    return { status: "unavailable", reason: failure ?? "expired", observedAt: snapshot.observedAt };
  }
  return {
    status: failure || age >= config.cacheTtlSeconds * 1000 ? "stale" : "fresh",
    reason: failure,
    observedAt: snapshot.observedAt,
    staleAt: new Date(observation + config.cacheTtlSeconds * 1000).toISOString(),
    data: snapshot
  };
}
