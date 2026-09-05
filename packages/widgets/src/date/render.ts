import type { WidgetRenderInput } from "../types.js";
import { cardFrame, escapeXml, fitText, renderScale, scaled, textWidth } from "../render-utils.js";

export interface DateWidgetConfig {
  format: "short" | "full" | "numeric";
  showWeekday: boolean;
  subtitle: string;
}

export function renderDateWidget(input: WidgetRenderInput<DateWidgetConfig>): string {
  const { rect, screen, now, timeZone } = input.context;
  const config = input.instance.config;
  const scale = renderScale(screen);
  const date = new Date(now);
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (name: string) => parts.find((entry) => entry.type === name)!.value;
  const dateText = config.format === "numeric" ? `${part("year")}/${part("month")}/${part("day")}`
    : `${config.format === "full" ? `${part("year")}年` : ""}${Number(part("month"))}月${Number(part("day"))}日`;
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
  const padding = Math.min(scaled(18, scale), rect.height * 0.12);
  const width = rect.width - padding * 2;
  const secondarySize = Math.max(1, Math.min(scaled(14, scale), rect.height * 0.13));
  const gap = Math.min(scaled(10, scale), rect.height * 0.07);
  const secondaryRows = Number(config.showWeekday) + Number(Boolean(config.subtitle));
  const mainSize = Math.max(1, Math.floor(Math.min(scaled(42, scale), width / textWidth(dateText, 1), (rect.height - padding * 2 - secondaryRows * (secondarySize * 1.3 + gap)) / 1.2)));
  const totalHeight = mainSize * 1.2 + secondaryRows * (secondarySize * 1.3 + gap);
  const mainY = (rect.height - totalHeight) / 2 + mainSize;
  const weekdayY = mainY + mainSize * 0.2 + gap + secondarySize;
  const subtitleY = config.showWeekday ? weekdayY + secondarySize * 1.3 + gap : weekdayY;

  return `
    ${cardFrame(rect, undefined, scale)}
    <text x="${padding}" y="${mainY}" font-size="${mainSize}" font-weight="800" fill="#171717">${escapeXml(dateText)}</text>
    ${config.showWeekday ? `<text x="${padding}" y="${weekdayY}" font-size="${secondarySize}" font-weight="700">${escapeXml(weekday)}</text>` : ""}
    ${config.subtitle ? `<text x="${padding}" y="${subtitleY}" font-size="${secondarySize}" fill="#666666">${escapeXml(fitText(config.subtitle, width, secondarySize))}</text>` : ""}
  `;
}
