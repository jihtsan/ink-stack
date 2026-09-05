import type { WidgetRenderInput } from "../types.js";
import { cardFrame, escapeXml, fitText, renderScale, scaled, textWidth } from "../render-utils.js";
import type { CodexUsageSnapshot } from "./normalize.js";

export interface CodexUsageWidgetConfig {
  alias: string;
  connectionId: string;
  connectionRevision: number;
  quotaGroupId: string;
  lowBalanceThreshold: number;
}

export function renderCodexUsageWidget(input: WidgetRenderInput<CodexUsageWidgetConfig, CodexUsageSnapshot>): string {
  const { rect, screen, timeZone } = input.context;
  const config = input.instance.config;
  const scale = Math.min(renderScale(screen), rect.width / 200, rect.height / 300);
  const snapshot = input.data?.data;
  const state = snapshot?.state ?? input.data?.status ?? "unavailable";
  const windows = snapshot?.windows ?? [];
  const side = scaled(16, scale);
  const width = rect.width - side * 2;
  const title = fitText(`CODEX · ${config.alias || "账号"}`, width, scaled(17, scale));
  const group = fitText(snapshot?.quotaGroupName ?? config.quotaGroupId, width, scaled(12, scale));
  const envelopeObservedAt = input.data?.observedAt;
  const observedAt = snapshot?.observedAt ?? envelopeObservedAt;
  const observedAtText = observedAt ? formatDateTime(observedAt, timeZone) : "未采集";
  const stateText = fitText(stateTextFor(state), width, scaled(12, scale));
  const message = snapshot?.message ?? input.data?.message;
  const headerHeight = scaled(68, scale);
  const footerHeight = scaled(54, scale);
  const availableHeight = rect.height - headerHeight - footerHeight;
  const visibleWindows = windows.slice(0, 2);
  const blockHeight = Math.floor(availableHeight / Math.max(1, visibleWindows.length));

  const windowRows = visibleWindows.map((window, index) => {
    const y = headerHeight + scaled(13, scale) + index * blockHeight;
    const remaining = window.remainingPercent;
    const remainingText = remaining === undefined ? "剩余未知" : `剩余 ${Math.round(remaining)}%`;
    const reset = window.resetAt ? formatDateTime(window.resetAt, timeZone) : "时间未知";
    const barMaxWidth = width;
    const barWidth = remaining === undefined ? undefined : Math.max(0, Math.round((remaining / 100) * barMaxWidth));
    const low = remaining !== undefined && remaining <= config.lowBalanceThreshold;
    const bar = barWidth === undefined
      ? `<text x="${side}" y="${y + scaled(61, scale)}" font-size="${scaled(12, scale)}" fill="#666666">进度未知</text>`
      : `
      <rect x="${side}" y="${y + scaled(49, scale)}" width="${barMaxWidth}" height="${scaled(9, scale)}" rx="${scaled(4, scale)}" fill="#e3e3e3"/>
      <rect x="${side}" y="${y + scaled(49, scale)}" width="${barWidth}" height="${scaled(9, scale)}" rx="${scaled(4, scale)}" fill="${low ? "#111111" : "#444444"}"/>`;
    const percentSize = remaining === undefined ? scaled(24, scale) : scaled(31, scale);
    const resetText = window.resetPending ? `待更新 · ${reset}` : `重置 ${reset}`;
    return `
      <text x="${side}" y="${y}" font-size="${scaled(13, scale)}" font-weight="700">${escapeXml(fitText(window.label, width, scaled(13, scale)))}</text>
      <text x="${side}" y="${y + scaled(37, scale)}" font-size="${percentSize}" font-weight="800">${escapeXml(fitText(remainingText, width, percentSize))}</text>
      ${bar}
      <text x="${side}" y="${y + scaled(78, scale)}" font-size="${scaled(11, scale)}" fill="#666666">${escapeXml(fitText(resetText, width, scaled(11, scale)))}</text>
    `;
  }).join("");

  const emptyState = windowRows.length === 0
    ? `<text x="${side}" y="${headerHeight + availableHeight / 2 - scaled(12, scale)}" font-size="${scaled(20, scale)}" font-weight="700">${escapeXml(fitText(stateText, width, scaled(20, scale)))}</text>
       <text x="${side}" y="${headerHeight + availableHeight / 2 + scaled(16, scale)}" font-size="${scaled(12, scale)}" fill="#666666">${escapeXml(fitText(message ?? "等待可用额度数据", width, scaled(12, scale)))}</text>`
    : "";

  return `
    ${cardFrame(rect, undefined, scale)}
    <text x="${side}" y="${scaled(29, scale)}" font-size="${scaled(17, scale)}" font-weight="800">${escapeXml(title)}</text>
    <text x="${side}" y="${scaled(49, scale)}" font-size="${scaled(12, scale)}" fill="#666666">${escapeXml(group)}</text>
    <path d="M ${side} ${scaled(60, scale)} H ${rect.width - side}" stroke="#dedede" stroke-width="${scale}"/>
    ${windowRows}
    ${emptyState}
    <path d="M ${side} ${rect.height - footerHeight + scaled(2, scale)} H ${rect.width - side}" stroke="#dedede" stroke-width="${scale}"/>
    <text x="${side}" y="${rect.height - scaled(32, scale)}" font-size="${scaled(12, scale)}" fill="#555555">${escapeXml(fitText(message ?? stateText, width, scaled(12, scale)))}</text>
    <text x="${side}" y="${rect.height - scaled(14, scale)}" font-size="${Math.min(scaled(11, scale), width / textWidth(`采集于 ${observedAtText}`, 1))}" fill="#666666">${escapeXml(`采集于 ${observedAtText}`)}</text>
  `;
}

function stateTextFor(state: string): string {
  switch (state) {
    case "fresh":
      return "数据新鲜";
    case "stale":
      return "数据已过期";
    case "exhausted":
      return "额度已耗尽";
    case "unauthenticated":
      return "需要登录 Codex";
    case "unsupported":
      return "当前来源不支持额度";
    case "missing":
    case "unavailable":
      return "额度不可用";
    default:
      return "读取失败";
  }
}

function formatDateTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "时间无效";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}
