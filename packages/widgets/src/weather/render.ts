import type { WidgetRenderInput } from "../types.js";
import { cardFrame, escapeXml, fitText, renderScale, scaled, textWidth } from "../render-utils.js";
import { weatherEnvelope } from "./normalize.js";
import { renderWeatherDashboard } from "./dashboard.js";
import type { WeatherConfig, WeatherEnvelope, WeatherSnapshot } from "./types.js";

export function renderWeatherWidget(input: WidgetRenderInput<WeatherConfig, WeatherSnapshot>): string {
  const { rect, screen, now, timeZone } = input.context;
  const config = input.instance.config;
  const incoming = input.data as WeatherEnvelope | undefined;
  const envelope = incoming?.status === "unavailable" || incoming?.status === "unauthenticated"
    ? incoming
    : weatherEnvelope(incoming?.data?.units === config.units ? incoming.data : undefined, config, now,
      incoming?.status === "stale" ? incoming.reason === "expired" || incoming.reason === "missing" ? "response" : incoming.reason ?? "network" : undefined);
  const snapshot = envelope.status === "fresh" || envelope.status === "stale" ? envelope.data : undefined;
  if (config.forecastMode === "dashboard") return renderWeatherDashboard(input, envelope, reasonText(envelope));
  const wide = input.instance.columnSpan === 4;
  const scale = Math.min(renderScale(screen), rect.width / (wide ? 440 : 220), rect.height / 180);
  const side = scaled(13, scale);
  const width = rect.width - 2 * side;
  const currentWidth = wide && config.showForecast ? Math.floor(width * 0.47) : width;
  const tempUnit = config.units === "m" ? "°C" : "°F";
  const metric = (value: number | undefined, suffix: string) => value === undefined ? "—" : `${Math.round(value)}${suffix}`;
  const text = (value: string, x: number, y: number, size: number, available = width, weight = 400) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}">${escapeXml(fitText(value, available, size))}</text>`;
  const parts = [cardFrame(rect, undefined, scale), text(`${config.title || "天气"} · ${snapshot?.location ?? (config.locationMode === "city" ? config.city : `${config.longitude},${config.latitude}`)}`, side, scaled(24, scale), scaled(16, scale), width, 700)];
  if (snapshot) {
    if (config.showTemperature) parts.push(text(metric(snapshot.temperature, tempUnit), side, scaled(68, scale), scaled(36, scale), currentWidth, 800));
    if (config.showCondition) parts.push(text(snapshot.condition, side, scaled(88, scale), scaled(14, scale), currentWidth, 700));
    const details: string[] = [];
    if (config.showFeelsLike) details.push(`体感 ${metric(snapshot.feelsLike, tempUnit)}`);
    if (config.showHumidity) details.push(`湿度 ${metric(snapshot.humidity, "%")}`);
    if (config.showWind) details.push(`风速 ${metric(snapshot.windSpeed, config.units === "m" ? "km/h" : "mph")}`);
    const detailLines: string[] = [];
    for (const detail of details) {
      const last = detailLines.at(-1);
      if (last && textWidth(`${last} · ${detail}`, scaled(11, scale)) <= currentWidth) detailLines[detailLines.length - 1] = `${last} · ${detail}`;
      else detailLines.push(detail);
    }
    detailLines.slice(0, 2).forEach((line, index) => {
      parts.push(text(line, side, scaled(105 + index * 16, scale), scaled(11, scale), currentWidth));
    });
    if (wide && config.showForecast) {
      const x = side + Math.floor(width * 0.53);
      const forecastWidth = rect.width - side - x;
      parts.push(`<path d="M ${x - side} ${scaled(37, scale)} V ${scaled(112, scale)}" stroke="#888888"/>`);
      switch (config.forecastMode ?? "daily") {
        case "hourly": {
          parts.push(text("逐小时预报", x, scaled(48, scale), scaled(14, scale), forecastWidth, 700));
          const hourly = (snapshot.hourlyForecast ?? []).slice(0, 6);
          if (hourly.length === 0) {
            parts.push(text(snapshot.hourlyError ? "逐小时预报暂不可用" : "暂无逐小时数据", x, scaled(77, scale), scaled(13, scale), forecastWidth));
          } else {
            hourly.forEach((hour, index) => {
              parts.push(text(formatHour(hour.time, timeZone) + " " + metric(hour.temperature, tempUnit) + " " + hour.condition, x, scaled(70 + index * 18, scale), scaled(12, scale), forecastWidth));
            });
          }
          break;
        }
        case "air-quality": {
          parts.push(text("空气质量", x, scaled(48, scale), scaled(14, scale), forecastWidth, 700));
          const airQuality = snapshot.airQuality;
          if (!airQuality) {
            parts.push(text(snapshot.airQualityError ? "空气质量暂不可用" : "暂无空气质量", x, scaled(78, scale), scaled(13, scale), forecastWidth));
          } else {
            parts.push(text("AQI " + airQuality.aqiDisplay, x, scaled(82, scale), scaled(27, scale), forecastWidth, 800));
            const category = airQuality.level ? airQuality.category + " · " + airQuality.level : airQuality.category;
            parts.push(text(category, x, scaled(104, scale), scaled(13, scale), forecastWidth, 700));
            if (airQuality.primaryPollutant) parts.push(text("首要 " + airQuality.primaryPollutant, x, scaled(124, scale), scaled(12, scale), forecastWidth));
            airQuality.pollutants.slice(0, 2).forEach((pollutant, index) => {
              parts.push(text(pollutant.name + " " + Math.round(pollutant.value) + (pollutant.unit ? " " + pollutant.unit : ""), x, scaled(144 + index * 16, scale), scaled(11, scale), forecastWidth));
            });
          }
          break;
        }
        default: {
          const today = localDate(now, timeZone);
          const forecast = (snapshot.forecast ?? []).filter((day) => day.date >= today).slice(0, 3);
          if (forecast.length === 0) parts.push(text(snapshot.forecastError ? "预报暂不可用" : "暂无预报", x, scaled(70, scale), scaled(14, scale), forecastWidth));
          forecast.forEach((day, index) => {
            const date = day.date === today ? "今天" : day.date.slice(5).replace("-", "/");
            parts.push(text(`${date} ${metric(day.minimum, "°")} / ${metric(day.maximum, "°")} ${day.condition}`, x, scaled(49 + index * 27, scale), scaled(13, scale), forecastWidth));
          });
        }
      }
    }
  } else {
    parts.push(text(envelope.reason === "missing" ? "暂无天气数据" : "天气暂不可用", side, scaled(69, scale), scaled(23, scale), width, 700));
    parts.push(text(reasonText(envelope), side, scaled(98, scale), scaled(13, scale)));
  }
  const state = envelope.status === "stale" ? "已过期 · 使用上次数据" : snapshot ? "当前天气" : "等待下次更新";
  parts.push(text(state, side, rect.height - scaled(47, scale), scaled(12, scale), width, envelope.status === "stale" ? 700 : 400));
  // Stale timestamps are mandatory, even if the normal timestamp display is disabled.
  if (config.showUpdatedAt || envelope.status === "stale") {
    parts.push(text(`观测 ${formatTime(envelope.observedAt, timeZone)}`, side, rect.height - scaled(29, scale), scaled(11, scale)));
  }
  const attribution = "QWeather https://www.qweather.com";
  parts.push(text(attribution, side, rect.height - scaled(10, scale), Math.min(scaled(9, scale), width / textWidth(attribution, 1))));
  return `<g fill="#111111">${parts.join("")}</g>`;
}

function reasonText(envelope: WeatherEnvelope): string {
  if (envelope.status === "unauthenticated" || envelope.reason === "authentication") return "天气连接认证失败";
  switch (envelope.reason) {
    case "connection": return "请配置天气连接";
    case "location": return "位置不明确，请使用 Location ID 或经纬度";
    case "expired": return "上次数据已超过保留期限";
    case "timeout": return "天气服务响应超时";
    case "network": return "天气服务暂时无法连接";
    case "response": return "天气数据格式异常";
    default: return "等待天气数据更新";
  }
}

function formatTime(value: string | undefined, timeZone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未采集";
  return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function formatHour(value: string, timeZone: string): string {
  if (!Number.isFinite(Date.parse(value))) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function localDate(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
