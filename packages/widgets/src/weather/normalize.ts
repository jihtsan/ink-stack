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
  const body = record(value);
  const code = String(body.code ?? "");
  if (code === "200" || (!code && ("temperature" in body || "days" in body))) return undefined;
  if (code === "401" || code === "403") return "authentication";
  if (code === "404") return "location";
  return "response";
}

/** Choose only an unambiguous location. Never silently select the first same-name city. */
export function normalizeWeatherLocation(value: unknown): { id: string; name: string; latitude?: number; longitude?: number } | undefined {
  const body = record(value);
  if (qweatherResponseError(body) || !Array.isArray(body.location) || body.location.length !== 1) return undefined;
  const item = record(body.location[0]);
  const latitude = number(item.lat, -90, 90);
  const longitude = number(item.lon, -180, 180);
  return typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(item.id) && label(item.name)
    ? { id: item.id, name: label(item.name), ...(latitude === undefined ? {} : { latitude }), ...(longitude === undefined ? {} : { longitude }) } : undefined;
}

/** Select known fields, preserve missing values, and reject incomplete current observations. */
export function normalizeWeatherSnapshot(
  current: unknown,
  daily: unknown,
  options: { location: string; units: "m" | "i"; apiVersion?: "v1" | "v7"; observedAtFallback?: string }
): WeatherSnapshot | undefined {
  const body = record(current);
  if (qweatherResponseError(body)) return undefined;
  const isV1 = options.apiVersion === "v1";
  const now = isV1 ? record(body) : record(body.now);
  const temperature = isV1 ? v1Measurement(record(now.temperature).value, options.units, "temperature") : number(now.temp);
  const observedAt = timestamp(isV1 ? body.updateTime ?? body.observedAt ?? options.observedAtFallback : now.obsTime);
  const condition = label(isV1 ? record(now.condition).text : now.text);
  if (temperature === undefined || !observedAt || !condition) return undefined;
  const forecastBody = record(daily);
  const forecast: WeatherSnapshot["forecast"] = [];
  if (!qweatherResponseError(forecastBody)) {
    const days = isV1 ? forecastBody.days : forecastBody.daily;
    if (Array.isArray(days)) for (const raw of days.slice(0, 3)) {
      const day = record(raw);
      const forecastStart = typeof day.forecastStartTime === "string" ? day.forecastStartTime : undefined;
      const date = isV1
        ? forecastStart && timestamp(forecastStart) ? forecastStart.slice(0, 10) : undefined
        : typeof day.fxDate === "string" ? day.fxDate : undefined;
      const minimum = isV1 ? v1Measurement(record(day.temperatureMin).value, options.units, "temperature") : number(day.tempMin);
      const maximum = isV1 ? v1Measurement(record(day.temperatureMax).value, options.units, "temperature") : number(day.tempMax);
      const conditionValue = isV1 ? record(record(day.daytime).condition).text ?? record(record(day.nighttime).condition).text : day.textDay;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || minimum === undefined || maximum === undefined || minimum > maximum) continue;
      if (forecast.some((item) => item.date === date)) continue;
      forecast.push({ date, minimum, maximum, condition: label(conditionValue) });
    }
    forecast.sort((a, b) => a.date.localeCompare(b.date));
  }
  const feelsLike = isV1 ? v1Measurement(record(now.feelsLike).value, options.units, "temperature") : number(now.feelsLike);
  const humidity = isV1 ? percentage(now.humidity) : number(now.humidity, 0, 100);
  const windSpeed = isV1 ? v1Measurement(record(record(now.wind).speed).value, options.units, "wind") : number(now.windSpeed, 0, 1000);
  return {
    location: label(options.location), units: options.units, observedAt, temperature, condition,
    ...(feelsLike === undefined ? {} : { feelsLike }), ...(humidity === undefined ? {} : { humidity }),
    ...(windSpeed === undefined ? {} : { windSpeed }), forecast
  };
}

function percentage(value: unknown): number | undefined {
  const parsed = number(value, 0, 1);
  return parsed === undefined ? undefined : parsed * 100;
}

function v1Measurement(value: unknown, units: "m" | "i", kind: "temperature" | "wind"): number | undefined {
  const parsed = number(value, kind === "temperature" ? -200 : 0, kind === "temperature" ? 200 : 1000);
  if (parsed === undefined) return undefined;
  if (units === "m") return parsed;
  return kind === "temperature" ? parsed * 9 / 5 + 32 : parsed * 2.2369362921;
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
