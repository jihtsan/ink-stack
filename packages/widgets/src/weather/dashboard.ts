import { weatherIcon } from "./icons.js";
import type { WidgetRenderInput } from "../types.js";
import { cardFrame, escapeXml, fitText } from "../render-utils.js";
import type { WeatherConfig, WeatherEnvelope, WeatherSnapshot } from "./types.js";

/** The same measured card is used by the editor and PNG renderer. */
export function renderWeatherDashboard(input: WidgetRenderInput<WeatherConfig, WeatherSnapshot>, envelope: WeatherEnvelope, failureMessage: string): string {
  const { rect, now, timeZone } = input.context;
  const config = input.instance.config;
  const iconStyle = config.iconStyle ?? "outline";
  const data = envelope.status === "fresh" || envelope.status === "stale" ? envelope.data : undefined;
  const scale = Math.min(rect.width / 260, rect.height / 360);
  const w = rect.width / scale;
  const h = rect.height / scale;
  const pad = 14;
  const width = w - pad * 2;
  const unit = config.units === "m" ? "°C" : "°F";
  const show = (flag: boolean | undefined) => config.showForecast && flag !== false;
  const text = (value: string, x: number, y: number, size: number, available = width, weight = 400, fill = "#222222") =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(fitText(value, available, size))}</text>`;
  const line = (y: number) => `<path d="M ${pad} ${y} H ${w - pad}" stroke="#d7d7d7"/>`;
  const parts = [text(config.title || "天气看板", pad, 25, 14, width, 700), line(35)];
  parts.push(text(data?.location ?? config.city, pad, 51, 10, width * .56, 600));
  if (!data) {
    parts.push(text("暂无天气数据", pad, 101, 24, width, 700), text(failureMessage, pad, 125, 12));
  } else {
    if (config.showTemperature) parts.push(text(`${Math.round(data.temperature)}${unit}`, pad, 91, 38, width * .62, 800));
    if (config.showCondition) parts.push(text(data.condition, pad + 19, 111, 12, width * .6 - 19, 600), weatherIcon(data.condition, pad, 98, 15, iconStyle, input.instance.id + "-current"));
    if (show(config.showAirQuality)) {
      const x = pad + width * .62;
      const available = width * .38;
      parts.push(text(data.airQuality ? `AQI ${data.airQuality.aqiDisplay}` : "AQI —", x, 57, 13, available, 700));
      parts.push(text(data.airQuality?.category ?? "暂不可用", x, 76, 10, available));
      const pm = data.airQuality?.pollutants.find(p => /pm2[._-]?5/i.test(p.code) || p.name === "PM2.5");
      parts.push(text(pm ? `PM2.5 ${Math.round(pm.value)}` : "PM2.5 —", x, 96, 10, available));
    }
    const metrics: string[] = [];
    if (config.showFeelsLike) metrics.push(`体感 ${data.feelsLike === undefined ? "—" : Math.round(data.feelsLike) + unit}`);
    if (config.showHumidity) metrics.push(`湿度 ${data.humidity === undefined ? "—" : Math.round(data.humidity) + "%"}`);
    if (config.showWind) metrics.push(`风速 ${data.windSpeed === undefined ? "—" : Math.round(data.windSpeed) + (config.units === "m" ? "km/h" : "mph")}`);
    if (show(config.showUv)) metrics.push(`UV ${data.forecast[0]?.uvIndex ?? "—"}`);
    // Two rows keep every selected metric visible, including on the minimum card size.
    metrics.forEach((metric, i) => parts.push(text(metric, pad + (i % 2) * width / 2, 129 + Math.floor(i / 2) * 15, 10, width / 2)));
    let top = metrics.length > 2 ? 157 : 143;
    if (show(config.showUv)) {
      const celsius = config.units === "m" ? data.temperature : (data.temperature - 32) * 5 / 9;
      const clothing = celsius < 10 ? "厚外套" : celsius < 20 ? "轻薄外套" : "轻便衣物";
      parts.push(text(`衣着参考：${clothing}${/雨/.test(data.condition) ? " · 出门带伞" : ""}`, pad, top + 2, 10));
      top += 18;
    }
    if (show(config.showHourly)) {
      parts.push(line(top - 6), text("24 小时逐时温度", pad, top + 7, 10, width, 600));
      const hours = data.hourlyForecast.filter(hour => Date.parse(hour.time) >= Date.parse(now)).slice(0, 24);
      if (!hours.length) parts.push(text("逐时预报暂不可用", pad, top + 35, 11));
      else {
        const low = Math.min(...hours.map(hour => hour.temperature));
        const high = Math.max(...hours.map(hour => hour.temperature));
        const cell = width / hours.length;
        hours.forEach((hour, i) => {
          const height = 8 + (hour.temperature - low) / Math.max(1, high - low) * 22;
          parts.push(`<rect x="${pad + i * cell}" y="${top + 47 - height}" width="${Math.max(1, cell - 2)}" height="${height}" rx="1" fill="#303030"/>`);
          if (i === 0 || i === hours.length - 1 || i === Math.floor(hours.length / 2)) {
            const label = new Intl.DateTimeFormat("zh-CN", {timeZone, hour: "2-digit", hourCycle: "h23"}).formatToParts(new Date(hour.time)).find(part => part.type === "hour")?.value ?? "";
            const x = Math.min(pad + i * cell, w - pad - 28);
            parts.push(text(`${label}时`, x, top + 61, 8, 28));
          }
        });
      }
      top += 78;
    }
    if (show(config.showDaily)) {
      parts.push(line(top - 6), text("未来 5 天天气", pad, top + 7, 10, width, 600));
      const date = new Intl.DateTimeFormat("en-CA", {timeZone, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date(now));
      const days = data.forecast.filter(day => day.date >= date).slice(0, 5);
      if (!days.length) parts.push(text("每日预报暂不可用", pad, top + 35, 11));
      else days.forEach((day, i) => {
        const cell = width / days.length;
        const x = pad + i * cell;
        parts.push(text(day.date.slice(5).replace("-", "/"), x, top + 24, 9, cell - 3));
        parts.push(weatherIcon(day.condition, x, top + 28, 13, iconStyle, input.instance.id + "-day-" + i));
        parts.push(text(day.condition, x + 15, top + 39, 8, cell - 18, 600));
        parts.push(text(`${Math.round(day.minimum)}/${Math.round(day.maximum)}°`, x, top + 56, 9, cell - 3));
      });
    }
  }
  const status = envelope.status === "stale" ? "已过期 · 使用上次数据" : data ? "当前天气" : "等待更新";
  parts.push(line(h - 38), text(status, pad, h - 27, 9, width, 600));
  if ((config.showUpdatedAt || envelope.status === "stale") && envelope.observedAt) {
    const date = new Intl.DateTimeFormat("zh-CN", {timeZone, month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).format(new Date(envelope.observedAt));
    parts.push(text(`观测 ${date}`, pad, h - 16, 8, width));
  }
  parts.push(text("QWeather https://www.qweather.com", pad, h - 5, 8));
  return `${cardFrame(rect, undefined, scale)}<g transform="scale(${scale})">${parts.join("")}</g>`;
}
