import type { WidgetRenderInput } from "../types.js";
import { cardFrame, escapeXml, fitText, renderScale } from "../render-utils.js";
import { addDays, calendarRange, dateInZone, displayedMonth, eventDates, eventsInRange, type CalendarConfig, type CalendarEvent, type CalendarSnapshot } from "./model.js";

export function renderCalendarWidget(input: WidgetRenderInput<CalendarConfig, CalendarSnapshot>): string {
  const { context, instance, data } = input;
  const { rect, now, timeZone } = context;
  const config = instance.config;
  const scale = Math.min(renderScale(context.screen), rect.width / 320, rect.height / 210);
  const padding = 12 * scale;
  const width = rect.width - padding * 2;
  const font = 14 * scale;
  const small = 11 * scale;
  const today = dateInZone(now, timeZone);
  const month = displayedMonth(config, now, timeZone);
  const age = data?.observedAt ? Date.parse(now) - Date.parse(data.observedAt) : NaN;
  const usable = config.connectionId && data?.data && ["fresh", "stale"].includes(data.status) && age >= 0 && age <= 3600_000;
  const stale = usable && (data?.status === "stale" || age > 600_000);
  const events = usable ? eventsInRange(data.data!.events.filter((event) => config.calendarIds.includes(event.calendarId)), calendarRange(config, now, timeZone)) : [];
  const footerTop = rect.height - 36 * scale;
  const text = (value: string, x: number, y: number, size: number, available = width, attributes = "") =>
    `<text x="${x}" y="${y}" font-size="${size}" ${attributes}>${escapeXml(fitText(value, available, size))}</text>`;
  let svg = cardFrame(rect, undefined, scale);
  const heading = config.layout === "list" ? `未来 ${config.eventRangeDays} 天` : month.replace("-", "年") + "月";
  svg += text(config.title, padding, 25 * scale, 18 * scale, width * 0.48, 'font-weight="700"');
  svg += text(heading, rect.width - padding, 25 * scale, font, width * 0.48, 'text-anchor="end"');
  let listTop = 40 * scale;
  // Short cards keep a legible month grid; larger combined cards add event rows below it.
  const combinedList = config.layout === "month-list" && rect.height >= 330 * scale;
  if (config.layout !== "list") {
    const top = 42 * scale;
    const weekdayHeight = config.showWeekdays ? 18 * scale : 0;
    const gridBottom = combinedList ? top + 190 * scale : footerTop - 7 * scale;
    const rowHeight = (gridBottom - top - weekdayHeight) / 6;
    const cellWidth = width / 7;
    const first = `${month}-01`;
    const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() - config.weekStartsOn + 7) % 7;
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    for (let column = 0; column < 7; column++) {
      const x = padding + (column + 0.5) * cellWidth;
      if (config.showWeekdays) svg += text(weekdays[(column + config.weekStartsOn) % 7]!, x, top + small, small, cellWidth, 'text-anchor="middle"');
    }
    const dayFont = Math.min(font, rowHeight * 0.55);
    for (let index = 0; index < 42; index++) {
      const day = addDays(first, index - offset);
      if (!day.startsWith(month)) continue;
      const x = padding + (index % 7 + 0.5) * cellWidth;
      const y = top + weekdayHeight + (Math.floor(index / 7) + 0.5) * rowHeight;
      if (day === today) svg += `<circle cx="${x}" cy="${y}" r="${dayFont * 0.85}" fill="#111111"/>`;
      svg += text(String(Number(day.slice(-2))), x, y + dayFont * 0.33, dayFont, cellWidth,
        `text-anchor="middle" fill="${day === today ? "#ffffff" : "#111111"}"`);
      if (events.some((event) => { const dates = eventDates(event, timeZone); return dates.start <= day && dates.last >= day; })) {
        svg += `<rect x="${x - 4 * scale}" y="${y + rowHeight * 0.43}" width="${8 * scale}" height="${scale}" fill="#111111"/>`;
      }
    }
    listTop = gridBottom + 20 * scale;
  }
  if (config.layout === "list" || combinedList) {
    const rowHeight = 38 * scale;
    const capacity = Math.max(0, Math.floor((footerTop - listTop - 17 * scale) / rowHeight));
    const visible = events.slice(0, Math.min(config.maxVisible, capacity));
    if (usable && events.length === 0) svg += text("此范围暂无日程", padding, listTop + font, font);
    visible.forEach((event, index) => {
      const y = listTop + index * rowHeight + font;
      svg += text(event.title, padding, y, font, width, 'font-weight="600"');
      svg += text(eventLabel(event, timeZone), padding, y + 15 * scale, small);
    });
    const hidden = events.length - visible.length;
    if (hidden > 0 || (usable && data.data!.truncated)) {
      svg += text(hidden > 0 ? `还有 ${hidden} 项${data?.data?.truncated ? "以上" : ""}` : "还有更多日程", padding, footerTop - 4 * scale, small);
    }
  }
  let status = !config.connectionId ? "未连接 Google Calendar" : data?.status === "unauthenticated" ? "Google 授权失效，请重新连接"
    : data?.status === "unsupported" ? "Google 授权接入尚未完成" : !usable ? "日程暂不可用" : stale ? "日程已过期" : `${events.length} 项日程${data.data!.truncated ? "以上" : ""}`;
  if (usable && data.data!.source === "fixture") status = `示例数据 · ${status}`;
  if (config.layout === "month-list" && !combinedList && usable) status += " · 切换列表查看";
  svg += text(status, padding, footerTop + small, small);
  if (usable && data?.observedAt) {
    const observed = new Intl.DateTimeFormat("zh-CN", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(data.observedAt));
    svg += text(`更新于 ${observed}`, padding, footerTop + small * 2.4, small);
  }
  return svg;
}

function eventLabel(event: CalendarEvent, timeZone: string): string {
  const { start, last } = eventDates(event, timeZone);
  const dates = start === last ? start.slice(5) : `${start.slice(5)}–${last.slice(5)}`;
  if (event.allDay) return `${dates} · 全天`;
  const time = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
  return `${dates} · ${time(event.start)}–${time(event.end)}`;
}

export type { CalendarConfig, CalendarEvent, CalendarSnapshot } from "./model.js";
