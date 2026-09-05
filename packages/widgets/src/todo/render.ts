import type { WidgetRenderInput } from "../types.js";
import { cardFrame, escapeXml, fitText, renderScale, scaled, textWidth } from "../render-utils.js";

export interface TodoItemConfig {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoWidgetConfig {
  title: string;
  items: TodoItemConfig[];
  sort: "manual" | "open-first";
  maxVisible: number;
}

export function renderTodoWidget(input: WidgetRenderInput<TodoWidgetConfig>): string {
  const { rect, screen } = input.context;
  const config = input.instance.config;
  const scale = Math.min(renderScale(screen), rect.height / 120, rect.width / 150);
  const items = [...config.items]
    .sort((left, right) => (config.sort === "open-first" ? Number(left.done) - Number(right.done) : 0))
    .slice(0, config.maxVisible);
  const side = scaled(16, scale);
  const rowHeight = scaled(30, scale);
  const contentStart = scaled(65, scale);
  const footerHeight = scaled(34, scale);
  const rowCapacity = (bottom: number) => Math.max(0, Math.floor((bottom - contentStart - scaled(4, scale)) / rowHeight) + 1);
  const needsFooter = config.items.length > Math.min(items.length, rowCapacity(rect.height - side));
  const maxRows = rowCapacity(rect.height - (needsFooter ? footerHeight + side : side));
  const visible = items.slice(0, maxRows);
  const hiddenCount = Math.max(0, config.items.length - visible.length);
  const itemFontSize = scaled(17, scale);
  const textX = side + scaled(24, scale);

  const rows = visible
    .map((item, index) => {
      const y = contentStart + index * rowHeight;
      const markerSize = scaled(12, scale);
      const text = fitText(item.text, rect.width - textX - side, itemFontSize);
      const decoration = item.done ? ' text-decoration="line-through" fill="#666666"' : "";
      return `<rect x="${side}" y="${y - markerSize}" width="${markerSize}" height="${markerSize}" rx="${scale}" fill="${item.done ? "#333333" : "#ffffff"}" stroke="#333333" stroke-width="${scale}"/>
        ${item.done ? `<text x="${side + markerSize / 2}" y="${y - scale}" font-size="${markerSize}" text-anchor="middle" fill="#ffffff">✓</text>` : ""}
        <text x="${textX}" y="${y}" font-size="${itemFontSize}"${decoration}>${escapeXml(text)}</text>`;
    })
    .join("");
  const more = hiddenCount > 0 ? `<path d="M ${side} ${rect.height - footerHeight} H ${rect.width - side}" stroke="#dedede" stroke-width="${scale}"/><text x="${side}" y="${rect.height - scaled(14, scale)}" font-size="${scaled(12, scale)}" fill="#666666">还有 ${hiddenCount} 项</text>` : "";
  const count = `${config.items.filter((item) => item.done).length}/${config.items.length}`;
  const countSize = scaled(12, scale);
  const titleSize = scaled(18, scale);
  const titleWidth = rect.width - side * 3 - textWidth(count, countSize);

  return `
    ${cardFrame(rect, undefined, scale)}
    <text x="${side}" y="${scaled(30, scale)}" font-size="${titleSize}" font-weight="800">${escapeXml(fitText(config.title, titleWidth, titleSize))}</text>
    <text x="${rect.width - side}" y="${scaled(29, scale)}" text-anchor="end" font-size="${countSize}" font-weight="700" fill="#555555">${count}</text>
    <path d="M ${side} ${scaled(43, scale)} H ${rect.width - side}" stroke="#dedede" stroke-width="${scale}"/>
    ${rows || `<text x="${scaled(18, scale)}" y="${contentStart}" font-size="${scaled(16, scale)}" fill="#666666">暂无待办</text>`}
    ${more}
  `;
}
