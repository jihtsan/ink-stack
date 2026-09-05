import type { WeatherConfig, WeatherAirQuality, WeatherEnvelope, WeatherError, WeatherHourlyForecast, WeatherSnapshot } from "./types.js";

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
  const hasKnownPayload = ["temperature", "days", "hours", "indexes", "location"].some((key) => key in body);
  if (code === "200" || (!code && hasKnownPayload)) return undefined;
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
  options: {
    location: string;
    units: "m" | "i";
    apiVersion?: "v1" | "v7";
    observedAtFallback?: string;
    hourly?: unknown;
    airQuality?: unknown;
  }
): WeatherSnapshot | undefined {
  const body = record(current);
  if (qweatherResponseError(body)) return undefined;
  const isV1 = options.apiVersion === "v1";
  const now = isV1 ? record(body) : record(body.now);
  const temperature = isV1 ? v1Measurement(record(now.temperature).value, options.units, "temperature") : number(now.temp);
  const observedAt = timestamp(isV1 ? body.updateTime ?? body.observedAt ?? options.observedAtFallback : now.obsTime);
  const condition = label(isV1 ? record(now.condition).text : now.text);
  if (temperature === undefined || !observedAt || !condition) return undefined;
  const forecast = normalizeDailyForecast(daily, options.units, isV1);
  const hourlyForecast = options.hourly === undefined ? [] : normalizeWeatherHourlyForecast(options.hourly, { units: options.units, apiVersion: isV1 ? "v1" : "v7" });
  const airQuality = options.airQuality === undefined ? undefined : normalizeWeatherAirQuality(options.airQuality);
  const feelsLike = isV1 ? v1Measurement(record(now.feelsLike).value, options.units, "temperature") : number(now.feelsLike);
  const humidity = isV1 ? percentage(now.humidity) : number(now.humidity, 0, 100);
  const windSpeed = isV1 ? v1Measurement(record(record(now.wind).speed).value, options.units, "wind") : number(now.windSpeed, 0, 1000);
  return {
    location: label(options.location), units: options.units, observedAt, temperature, condition,
    ...(feelsLike === undefined ? {} : { feelsLike }), ...(humidity === undefined ? {} : { humidity }),
    ...(windSpeed === undefined ? {} : { windSpeed }), forecast, hourlyForecast,
    ...(airQuality === undefined ? {} : { airQuality })
  };
}

function normalizeDailyForecast(value: unknown, units: "m" | "i", isV1: boolean): WeatherSnapshot["forecast"] {
  const body = record(value);
  const forecast: WeatherSnapshot["forecast"] = [];
  if (qweatherResponseError(body)) return forecast;
  const days = isV1 ? body.days : body.daily;
  if (!Array.isArray(days)) return forecast;
  for (const raw of days.slice(0, 3)) {
    const day = record(raw);
    const forecastStart = typeof day.forecastStartTime === "string" ? day.forecastStartTime : undefined;
    const date = isV1
      ? forecastStart && timestamp(forecastStart) ? forecastStart.slice(0, 10) : undefined
      : typeof day.fxDate === "string" ? day.fxDate : undefined;
    const minimum = isV1 ? v1Measurement(record(day.temperatureMin).value, units, "temperature") : number(day.tempMin);
    const maximum = isV1 ? v1Measurement(record(day.temperatureMax).value, units, "temperature") : number(day.tempMax);
    const conditionValue = isV1
      ? record(record(day.daytime).condition).text ?? record(record(day.nighttime).condition).text
      : day.textDay;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date)) || minimum === undefined || maximum === undefined || minimum > maximum) continue;
    if (forecast.some((item) => item.date === date)) continue;
    forecast.push({ date, minimum, maximum, condition: label(conditionValue) });
  }
  forecast.sort((a, b) => a.date.localeCompare(b.date));
  return forecast;
}

export function normalizeWeatherHourlyForecast(
  value: unknown,
  options: { units: "m" | "i"; apiVersion?: "v1" | "v7" }
): WeatherHourlyForecast[] {
  const body = record(value);
  if (qweatherResponseError(body)) return [];
  const isV1 = options.apiVersion === "v1";
  const rawHours = isV1 ? body.hours : body.hourly;
  if (!Array.isArray(rawHours)) return [];
  const hourly: WeatherHourlyForecast[] = [];
  for (const raw of rawHours.slice(0, 24)) {
    const hour = record(raw);
    const time = timestamp(isV1 ? hour.forecastTime : hour.fxTime);
    const temperature = isV1
      ? v1Measurement(record(hour.temperature).value, options.units, "temperature")
      : number(hour.temp);
    const condition = label(isV1 ? record(hour.condition).text : hour.text);
    if (!time || temperature === undefined || !condition) continue;
    const feelsLike = isV1
      ? v1Measurement(record(hour.feelsLike).value, options.units, "temperature")
      : number(hour.feelsLike);
    const humidity = isV1 ? percentage(hour.humidity) : number(hour.humidity, 0, 100);
    const windSpeed = isV1
      ? v1Measurement(record(record(hour.wind).speed).value, options.units, "wind")
      : number(hour.windSpeed, 0, 1000);
    hourly.push({
      time, temperature, condition,
      ...(feelsLike === undefined ? {} : { feelsLike }),
      ...(humidity === undefined ? {} : { humidity }),
      ...(windSpeed === undefined ? {} : { windSpeed })
    });
  }
  return hourly.sort((a, b) => a.time.localeCompare(b.time));
}

export function normalizeWeatherAirQuality(value: unknown): WeatherAirQuality | undefined {
  const body = record(value);
  if (qweatherResponseError(body) || !Array.isArray(body.indexes)) return undefined;
  const indexes = body.indexes.map(record);
  const index = indexes.find((item) => item.code === "cn-mee")
    ?? indexes.find((item) => number(item.aqi, 0, 1000) !== undefined || label(item.aqiDisplay) || label(item.category));
  if (!index) return undefined;
  const aqi = number(index.aqi, 0, 1000);
  const aqiDisplay = label(index.aqiDisplay) || (aqi === undefined ? "" : String(Math.round(aqi)));
  const category = label(index.category) || label(index.name);
  if (!aqiDisplay && !category) return undefined;
  const primary = record(index.primaryPollutant);
  const primaryPollutant = label(primary.name) || label(index.primaryPollutant);
  const pollutants = Array.isArray(body.pollutants)
    ? body.pollutants.flatMap((raw) => {
      const pollutant = record(raw);
      const concentration = record(pollutant.concentration);
      const pollutantValue = number(concentration.value ?? pollutant.value, 0, 100000);
      const name = label(pollutant.name);
      const code = label(pollutant.code);
      const unit = label(concentration.unit ?? pollutant.unit);
      return pollutantValue === undefined || !name || !/^[a-z0-9_-]{1,24}$/i.test(code) ? [] : [{ code, name, value: pollutantValue, unit }];
    }).slice(0, 6)
    : [];
  return {
    ...(aqi === undefined ? {} : { aqi }),
    aqiDisplay: aqiDisplay || "—",
    ...(label(index.level) ? { level: label(index.level) } : {}),
    category: category || "未知",
    ...(primaryPollutant ? { primaryPollutant } : {}),
    pollutants
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
