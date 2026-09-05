import { afterEach, describe, expect, it, vi } from "vitest";
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { validateWidgetInstanceConfig, widgetCatalog } from "../catalog.js";
import { renderWidgetToSvg } from "../registry.server.js";
import { textWidth } from "../render-utils.js";
import { collectWeather, validQWeatherConnection, weatherCacheKey, type QWeatherConnection, type QWeatherTransport } from "./server.js";
import { normalizeWeatherLocation, normalizeWeatherSnapshot, weatherEnvelope } from "./normalize.js";
import { renderWeatherWidget } from "./render.js";
import type { WeatherConfig, WeatherError } from "./types.js";
import defaults from "./defaults.json" with { type: "json" };
import connectionSchema from "./connection.schema.json" with { type: "json" };
import current from "./fixtures/current.json" with { type: "json" };
import daily from "./fixtures/daily.json" with { type: "json" };
import location from "./fixtures/location.json" with { type: "json" };
import states from "./fixtures/states.json" with { type: "json" };

const config = { ...defaults, connectionId: "weather-home" } as WeatherConfig;
const connection: QWeatherConnection = { id: config.connectionId, revision: 1, type: "qweather", apiHost: "h2a9cf3mhs.xy.qweatherapi.com", authMode: "jwt", secretRef: "secret-weather", authRevision: 1, identity: "weather-project" };
const now = "2026-09-05T00:05:00Z";
const snapshot = normalizeWeatherSnapshot(current, daily, { location: "北京", units: "m" })!;
const instance = { id: "weather-1", type: "weather", configVersion: 1, column: 0, row: 0, columnSpan: 2, rowSpan: 2, config };
const context = { now, timeZone: "Asia/Shanghai", screen: { width: 600, height: 800 }, rect: { x: 0, y: 0, width: 260, height: 240 } };
const makeTransport = () => vi.fn<QWeatherTransport>(async ({ url }) => url.includes("/geo/") ? location : url.includes("/3d") ? daily : current);
afterEach(() => vi.useRealTimers());

describe("weather contracts and normalization", () => {
  it("registers weather defaults and renderer without data", () => {
    expect(validateWidgetInstanceConfig({ ...instance, config: defaults })).toEqual({ ok: true });
    expect(widgetCatalog.find((entry) => entry.manifest.type === "weather")?.manifest.supportedSizes).toEqual([{ columns: 2, rows: 2 }, { columns: 4, rows: 2 }]);
    expect(renderWidgetToSvg({ ...instance, config: defaults }, context)).toContain("暂无天气数据");
  });
  it.each([
    { city: " " }, { latitude: -91 }, { longitude: 181 }, { units: "kelvin" }, { refreshSeconds: 0 },
    { cacheTtlSeconds: 0 }, { maxStaleSeconds: -1 }, { connectionRevision: 0 }, { connectionRevision: 1.5 },
    { apiKey: "DO_NOT_SERIALIZE" }, { jwt: "DO_NOT_SERIALIZE" }, { apiHost: "localhost" }, { secretRef: "hidden" }
  ])("rejects invalid/public secret config %j", (patch) => {
    expect(validateWidgetInstanceConfig({ ...instance, config: { ...defaults, ...patch } }).ok).toBe(false);
  });
  it("permits coordinate configuration with an empty unused city", () => {
    expect(validateWidgetInstanceConfig({ ...instance, config: { ...defaults, locationMode: "coordinates", city: "", latitude: 0, longitude: 0 } }).ok).toBe(true);
  });
  it("matches runtime and connection schema host checks and keeps credentials out", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(connectionSchema);
    for (const apiHost of ["h2a9cf3mhs.xy.qweatherapi.com", "project.qweatherapi.com", "http://localhost", "qweatherapi.com.evil.test", "x.qweatherapi.com/path", "user@x.qweatherapi.com", "127.0.0.1", "x.qweatherapi.com:443", "x.qweatherapi.com?key=secret"]) {
      expect(validate({ apiHost, authMode: "jwt", secretRef: "ref" })).toBe(validQWeatherConnection({ ...connection, apiHost }));
    }
    expect(validate({ apiHost: connection.apiHost, authMode: "jwt", secretRef: "ref", jwt: "raw-secret" })).toBe(false);
  });
  it("rejects missing numbers instead of creating zeroes; preserves real zero", () => {
    for (const temp of [null, "", "NaN", "Infinity", "300", [], true]) {
      expect(normalizeWeatherSnapshot({ ...current, now: { ...current.now, temp } }, daily, { location: "北京", units: "m" })).toBeUndefined();
    }
    const result = normalizeWeatherSnapshot({ ...current, now: { ...current.now, temp: "0", humidity: "0", feelsLike: null, windSpeed: "" } }, {}, { location: "北京", units: "m" })!;
    expect(result.temperature).toBe(0);
    expect(result.humidity).toBe(0);
    expect(result.feelsLike).toBeUndefined();
    expect(result.windSpeed).toBeUndefined();
    expect(result.forecast).toEqual([]);
  });
  it("drops arbitrary provider fields, error bodies and malformed forecasts", () => {
    const result = normalizeWeatherSnapshot({ ...current, token: "SENTINEL", now: { ...current.now, secret: "SENTINEL" } }, { code: "200", daily: [{ fxDate: "bad", tempMin: "10", tempMax: "30" }, { fxDate: "2026-09-05", tempMin: "40", tempMax: "30" }] }, { location: "北京", units: "m" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(result?.forecast).toEqual([]);
    expect(normalizeWeatherSnapshot({ code: "401", message: "SENTINEL" }, daily, { location: "北京", units: "m" })).toBeUndefined();
  });
  it("rejects malformed timestamps and ambiguous cities", () => {
    for (const obsTime of ["invalid", "2026-09-05", "2026-09-05T00:00:00"]) {
      expect(normalizeWeatherSnapshot({ ...current, now: { ...current.now, obsTime } }, daily, { location: "北京", units: "m" })).toBeUndefined();
    }
    expect(normalizeWeatherLocation({ ...location, location: [...location.location, ...location.location] })).toBeUndefined();
  });
  it.each(states)("handles $name fixture", (state) => {
    const result = weatherEnvelope(state.noData ? undefined : snapshot, config, state.now, state.failure as WeatherError | undefined);
    expect(result.status).toBe(state.status);
    if (result.status === "unavailable" || result.status === "unauthenticated") expect(result.data).toBeUndefined();
  });
  it("uses observation time at TTL boundaries and rejects future observations", () => {
    expect(weatherEnvelope(snapshot, config, "2026-09-05T00:29:59Z").status).toBe("fresh");
    expect(weatherEnvelope(snapshot, config, "2026-09-05T00:30:00Z").status).toBe("stale");
    expect(weatherEnvelope(snapshot, config, "2026-09-05T02:30:01Z").data).toBeUndefined();
    expect(weatherEnvelope(snapshot, config, "2026-09-04T23:59:59Z").data).toBeUndefined();
  });
});

describe("server collection", () => {
  it.each(["jwt", "api-key"] as const)("uses fixed %s authentication metadata and never query secrets", async (authMode) => {
    const transport = makeTransport();
    const result = await collectWeather({ config, connection: { ...connection, authMode }, now, transport });
    expect(result.envelope.status).toBe("fresh");
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [request] of transport.mock.calls) {
      expect(new URL(request.url).host).toBe(connection.apiHost);
      expect(request.url).not.toContain(connection.secretRef);
      expect(request.authentication).toEqual({ secretRef: connection.secretRef, header: authMode === "jwt" ? "Authorization" : "X-QW-Api-Key", prefix: authMode === "jwt" ? "Bearer " : "" });
      expect(request.redirect).toBe("error");
      expect(request.maxResponseBytes).toBe(262144);
    }
    expect(JSON.stringify(result.envelope)).not.toContain(connection.secretRef);
    expect(JSON.stringify(result.envelope)).not.toContain(connection.apiHost);
  });
  it("requests lon,lat coordinates rounded to two decimals and selected units", async () => {
    const transport = makeTransport();
    await collectWeather({ config: { ...config, locationMode: "coordinates", longitude: 116.415, latitude: 39.924, units: "i", showForecast: false }, connection, now, transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const url = new URL(transport.mock.calls[0]![0].url);
    expect(url.searchParams.get("location")).toBe("116.42,39.92");
    expect(url.searchParams.get("unit")).toBe("i");
  });
  it("reuses fresh cache within refresh interval; rotation and location/unit changes isolate it", async () => {
    const transport = makeTransport();
    const first = await collectWeather({ config, connection, now, transport });
    transport.mockClear();
    const second = await collectWeather({ config, connection, now, transport, cache: first.cache });
    expect(second.cache).toBe(first.cache);
    expect(transport).not.toHaveBeenCalled();
    const failed = vi.fn<QWeatherTransport>(async () => { throw new Error("SENTINEL"); });
    for (const changed of [{ ...connection, authRevision: 2 }, { ...connection, identity: "other" }, { ...connection, secretRef: "other-ref" }]) {
      expect((await collectWeather({ config, connection: changed, now, transport: failed, cache: first.cache })).envelope.data).toBeUndefined();
    }
    for (const changed of [{ ...config, units: "i" as const }, { ...config, city: "上海" }]) {
      expect((await collectWeather({ config: changed, connection, now, transport: failed, cache: first.cache })).envelope.data).toBeUndefined();
    }
    expect(weatherCacheKey(config, connection)).not.toBe(weatherCacheKey(config, { ...connection, revision: 2 }));
  });
  it("fails closed without a valid connection or matching revision before invoking transport", async () => {
    const transport = makeTransport();
    for (const invalid of [undefined, { ...connection, apiHost: "localhost" }, { ...connection, secretRef: "" }, { ...connection, revision: 2 }]) {
      expect((await collectWeather({ config, connection: invalid, now, transport })).envelope).toEqual({ status: "unavailable", reason: "connection" });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("sanitizes auth errors; keeps bounded stale cache with original observation time", async () => {
    const first = await collectWeather({ config, connection, now, transport: makeTransport() });
    const transport = vi.fn<QWeatherTransport>(async () => ({ code: "401", message: "SECRET_SENTINEL" }));
    const result = await collectWeather({ config, connection, now: "2026-09-05T01:00:00Z", transport, cache: first.cache });
    expect(result.envelope.status).toBe("stale");
    expect(result.envelope.observedAt).toBe(snapshot.observedAt);
    expect(result.envelope.reason).toBe("authentication");
    const empty = await collectWeather({ config, connection, now, transport });
    expect(empty.envelope.status).toBe("unauthenticated");
    expect(JSON.stringify([result, empty])).not.toContain("SECRET_SENTINEL");
  });
  it("bounds total timeout and aborts even a transport that never settles", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<QWeatherTransport>(() => new Promise(() => {}));
    const promise = collectWeather({ config, connection, now, transport, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.envelope).toEqual({ status: "unavailable", reason: "timeout" });
    expect(transport.mock.calls[0]![0].signal.aborted).toBe(true);
  });
  it("rejects ambiguous locations and keeps valid current data when optional forecast fails", async () => {
    const ambiguous = await collectWeather({ config, connection, now, transport: async () => ({ ...location, location: [...location.location, ...location.location] }) });
    expect(ambiguous.envelope.reason).toBe("location");
    const result = await collectWeather({ config, connection, now, transport: async ({ url }) => url.includes("/geo/") ? location : url.includes("/3d") ? { code: "500" } : current });
    expect(result.envelope.status).toBe("fresh");
    expect(result.envelope.data?.forecast).toEqual([]);
    expect(result.envelope.data?.forecastError).toBe("response");
    expect(renderWeatherWidget({ instance: { ...instance, columnSpan: 4 }, context, data: result.envelope })).toContain("预报暂不可用");
  });
  it("does not cache future data or replace newer observations with older upstream data", async () => {
    const first = await collectWeather({ config, connection, now, transport: makeTransport() });
    const future = { ...current, now: { ...current.now, obsTime: "2026-09-06T08:00+08:00" } };
    const transport = async ({ url }: Parameters<QWeatherTransport>[0]) => url.includes("/geo/") ? location : url.includes("/3d") ? daily : future;
    expect((await collectWeather({ config, connection, now, transport })).cache).toBeUndefined();
    const older = { ...current, now: { ...current.now, obsTime: "2026-09-05T07:30+08:00" } };
    const result = await collectWeather({ config, connection, now: "2026-09-05T01:00:00Z", cache: first.cache, transport: async ({ url }) => url.includes("/geo/") ? location : url.includes("/3d") ? daily : older });
    expect(result.cache).toBe(first.cache);
    expect(result.envelope.status).toBe("stale");
  });
});

describe("pure weather rendering", () => {
  it.each([{ columnSpan: 2, width: 220, height: 180 }, { columnSpan: 4, width: 460, height: 180 }, { columnSpan: 2, width: 480, height: 450 }, { columnSpan: 4, width: 1000, height: 450 }])("reflows and bounds every state at $columnSpan columns ($width × $height)", ({ columnSpan, width, height }) => {
    for (const state of states) {
      const data = weatherEnvelope(state.noData ? undefined : { ...snapshot, location: "中文超长地名".repeat(30), condition: "阴天转多云".repeat(30) }, config, state.now, state.failure as WeatherError | undefined);
      const svg = renderWeatherWidget({ instance: { ...instance, columnSpan }, context: { ...context, now: state.now, rect: { x: 0, y: 0, width, height } }, data });
      expect(svg).toContain("QWeather");
      expect(svg.includes("今天")).toBe(columnSpan === 4 && !!data.data);
      for (const match of svg.matchAll(/<text x="([^"]+)" y="([^"]+)" font-size="([^"]+)"[^>]*>([^<]*)<\/text>/g)) {
        const [, x, y, size, value] = match;
        expect(Number(y) - Number(size)).toBeGreaterThanOrEqual(0);
        expect(Number(y) + Number(size) * 0.2).toBeLessThan(height);
        expect(Number(x) + textWidth(value!, Number(size))).toBeLessThanOrEqual(width);
      }
    }
  });
  it("escapes XML, uses fixed time, keeps repeated instances independent and makes stale time mandatory", () => {
    const changed = { ...instance, config: { ...config, title: "<title>", showUpdatedAt: false } };
    const data = weatherEnvelope(snapshot, config, "2026-09-05T01:00:00Z");
    const input = { instance: changed, context: { ...context, now: "2026-09-05T01:00:00Z" }, data };
    const svg = renderWeatherWidget(input);
    expect(svg).toContain("&lt;title&gt;");
    expect(svg).toContain("已过期");
    expect(svg).toContain("09/05 08:00");
    expect(renderWeatherWidget(input)).toBe(svg);
    expect(renderWeatherWidget({ ...input, instance: { ...changed, id: "other" } })).toBe(svg);
    expect(svg).not.toContain("id=");
  });
  it("respects display flags and refuses stale expired or differently unit-labelled data", () => {
    const hidden = { ...config, showTemperature: false, showCondition: false, showHumidity: false, showForecast: false, showUpdatedAt: false };
    const input = { instance: { ...instance, columnSpan: 4, config: hidden }, context, data: weatherEnvelope(snapshot, config, now) };
    const svg = renderWeatherWidget(input);
    for (const text of ["26°C", "晴", "湿度", "今天", "观测"]) expect(svg).not.toContain(text);
    const expired = renderWeatherWidget({ ...input, context: { ...context, now: "2026-09-05T04:00:00Z" } });
    expect(expired).toContain("超过保留期限");
    const wrongUnit = renderWeatherWidget({ ...input, instance: { ...instance, config: { ...config, units: "i" } } });
    expect(wrongUnit).not.toContain("26°F");
  });
  it("keeps network code out of the public renderer and catalog import graph", () => {
    for (const file of ["../render.ts", "../catalog.ts", "./render.ts", "./normalize.ts", "./types.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text).not.toMatch(/from ["'][^"']*(?:weather\/server|registry\.server|node:)/);
      expect(text).not.toMatch(/\bfetch\(|\bDate\.now\(/);
    }
  });
});
