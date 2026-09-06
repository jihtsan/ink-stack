import { describe, expect, it, vi } from "vitest";
import { collectWeather, weatherCacheKey, type QWeatherConnection, type QWeatherTransport } from "./server.js";
import { renderWeatherWidget } from "./render.js";
import { normalizeWeatherSnapshot, weatherEnvelope } from "./normalize.js";
import type { WeatherConfig } from "./types.js";
import defaults from "./defaults.json" with { type: "json" };
import current from "./fixtures/current.json" with { type: "json" };
import daily from "./fixtures/daily.json" with { type: "json" };
import hourly from "./fixtures/hourly.json" with { type: "json" };
import air from "./fixtures/air-current.json" with { type: "json" };

const config: WeatherConfig = { ...defaults, locationMode: "coordinates", units: "m", forecastMode: "dashboard", connectionId: "test" };
const connection: QWeatherConnection = { id: "test", revision: 1, type: "qweather", apiHost: "test.qweatherapi.com", authMode: "api-key", secretRef: "private", authRevision: 1, identity: "test" };
const now = "2026-09-05T00:05:00Z";
const instance = { id: "weather", type: "weather", configVersion: 1, column: 0, row: 0, columnSpan: 2, rowSpan: 2, config };
const context = { now, timeZone: "Asia/Shanghai", screen: { width: 1072, height: 1448 }, rect: { x: 0, y: 0, width: 480, height: 520 } };
const transport = () => vi.fn<QWeatherTransport>(async ({url}) => url.includes("/7d") ? daily : url.includes("/24h") ? hourly : url.includes("/airquality/") ? air : current);

describe("Stitch weather dashboard", () => {
  it("labels hourly temperatures with a single localized hour suffix", async () => {
    const result = await collectWeather({config, connection, now, transport: async request => request.url.includes("/24h")
      ? {code: "200", hourly: hourly.hours.map(hour => ({fxTime: hour.forecastTime, temp: String(hour.temperature.value), text: hour.condition.text}))}
      : transport()(request)});
    const svg = renderWeatherWidget({instance, context, data: result.envelope});
    expect(svg).toMatch(/\d{2}时<\/text>/);
    expect(svg).not.toContain("时时");
  });
  it("collects independent modules and retains successful data when one module fails", async () => {
    const mock = transport();
    const result = await collectWeather({config, connection, now, transport: async request => request.url.includes("/24h") ? {code: "500"} : mock(request)});
    expect(result.envelope.status).toBe("fresh");
    expect(result.envelope.data?.forecast).toHaveLength(3);
    expect(result.envelope.data?.airQuality).toBeDefined();
    expect(result.envelope.data?.hourlyError).toBe("response");
    const svg = renderWeatherWidget({instance, context, data: result.envelope});
    expect(svg).toContain("逐时预报暂不可用");
    expect(svg).toContain("未来 5 天天气");
    expect(svg).toContain("AQI");
  });
  it("skips disabled modules and invalidates cached data on module changes", async () => {
    const disabled = {...config, showAirQuality:false, showHourly:false, showDaily:false, showUv:false};
    const mock = transport();
    const result = await collectWeather({config:disabled, connection, now, transport:mock});
    expect(mock).toHaveBeenCalledTimes(1);
    expect(weatherCacheKey(disabled, connection)).not.toBe(weatherCacheKey(config, connection));
    const svg = renderWeatherWidget({instance:{...instance,config:disabled},context,data:result.envelope});
    for (const label of ["AQI", "PM2.5", "逐时", "未来 5 天", "UV"]) expect(svg).not.toContain(label);
  });
  it("normalizes five days and UV without inventing missing observations", () => {
    const days = Array.from({length:5}, (_,i) => ({...daily.daily[0],fxDate:`2026-09-0${5+i}`,uvIndex:i===0?"3":undefined}));
    const data = normalizeWeatherSnapshot(current,{code:"200",daily:days},{location:"北京",units:"m"})!;
    expect(data.forecast).toHaveLength(5);
    expect(data.forecast[0]?.uvIndex).toBe(3);
    expect(data.forecast[1]?.uvIndex).toBeUndefined();
    const svg=renderWeatherWidget({instance,context,data:weatherEnvelope(data,config,now)});
    expect(svg).toContain("UV 3");
    expect(svg).toContain("09/09");
  });
  it("preserves stale observation labels and escapes configured titles", () => {
    const data=normalizeWeatherSnapshot(current,daily,{location:"北京",units:"m"})!;
    const staleNow="2026-09-05T02:05:00Z";
    const svg=renderWeatherWidget({instance:{...instance,config:{...config,title:"<气象>",showUpdatedAt:false}},context:{...context,now:staleNow},data:weatherEnvelope(data,config,staleNow)});
    expect(svg).toContain("&lt;气象&gt;");expect(svg).toContain("已过期");expect(svg).toContain("观测");
    expect(svg).not.toMatch(/电量|电池|BATTERY|14:28/);
  });
});

it("fetches 24 hours and five days from v1 and requests UV even with the daily panel hidden", async () => {
  const seen: URL[]=[];
  await collectWeather({config:{...config,showDaily:false},connection:{...connection,apiVersion:"v1"},now,transport:async request=>{
    const url=new URL(request.url);seen.push(url);
    if(url.pathname.includes('/current/')&&!url.pathname.includes('airquality'))return {temperature:{value:24},condition:{text:'晴'},updateTime:now};
    return {code:'500'};
  }});
  expect(seen.find(url=>url.pathname.includes('/hourly/'))?.searchParams.get('hours')).toBe('24');
  expect(seen.find(url=>url.pathname.includes('/daily/'))?.searchParams.get('days')).toBe('5');
});

it.each(['outline','dot','solid'] as const)('renders the %s library icons with isolated IDs', iconStyle=>{
  const data=normalizeWeatherSnapshot(current,daily,{location:'北京',units:'m'})!;
  const svg=renderWeatherWidget({instance:{...instance,config:{...config,iconStyle}},context,data:weatherEnvelope(data,config,now)});
  expect(svg).toContain('viewBox="0 -960 960 960"');
  expect(svg).not.toContain('https://raw.githubusercontent.com');
  if(iconStyle==='dot')expect(svg).toContain('<pattern');
});
