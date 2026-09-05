import type { WidgetRenderRect } from "@ink-stack/shared";

export const DEFAULT_FONT_FAMILY = "Noto Sans CJK SC";

export function renderScale(screen: { width: number; height: number }): number {
  return Math.max(0.75, Math.min(2.5, Math.min(screen.width / 600, screen.height / 800)));
}

export function scaled(value: number, scale: number): number {
  return Math.round(value * scale);
}

export function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function cardFrame(rect: WidgetRenderRect, title?: string, scale = 1): string {
  const titleText = title ? `<text x="14" y="28" font-size="18" font-weight="700">${escapeXml(title)}</text>` : "";
  return `
    <rect x="${scale}" y="${scale}" width="${Math.max(0, rect.width - scale * 2)}" height="${Math.max(0, rect.height - scale * 2)}" rx="${scaled(10, scale)}" fill="#ffffff" stroke="#b8b8b8" stroke-width="${scale}"/>
    ${titleText}
  `;
}

// Conservative em estimates keep CJK full-width glyphs inside their allocated SVG region.
export function textWidth(text: string, fontSize: number): number {
  return [...text].reduce((width, char) => width + (/^[\x20-\x7e]$/.test(char) && !/[MWmw@]/.test(char) ? 0.65 : 1), 0) * fontSize;
}

export function fitText(text: string, width: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= width) return text;
  const chars = [...text];
  while (chars.length && textWidth(`${chars.join("")}…`, fontSize) > width) chars.pop();
  return width >= fontSize ? `${chars.join("")}…` : "";
}

export function wrapTextToWidth(text: string, width: number, fontSize: number, maxLines: number): string[] {
  if (maxLines < 1 || width < fontSize) return [];
  const chars = [...text.replace(/\s+/g, " ").trim()];
  const lines: string[] = [];
  let offset = 0;
  while (offset < chars.length && lines.length < maxLines) {
    let line = "";
    while (offset < chars.length && textWidth(line + chars[offset]!, fontSize) <= width) line += chars[offset++]!;
    if (lines.length === maxLines - 1 && offset < chars.length) line = fitText(`${line}…`, width, fontSize);
    lines.push(line);
  }
  return lines;
}

export function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  for (const char of normalized) {
    if ([...current].length + 1 > maxCharsPerLine) {
      lines.push(current);
      current = char;
      if (lines.length === maxLines) {
        break;
      }
    } else {
      current += char;
    }
  }
  if (lines.length < maxLines && current.length > 0) {
    lines.push(current);
  }
  if (lines.length === maxLines && normalized.length > lines.join("").length) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = last.length > 1 ? `${last.slice(0, -1)}…` : "…";
  }
  return lines;
}

export function truncateText(text: string, maxChars: number): string {
  const chars = [...text.trim()];
  if (chars.length <= maxChars) {
    return text.trim();
  }
  return maxChars <= 1 ? "…" : `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function svgTextLines(lines: readonly string[], x: number, y: number, lineHeight: number, fontSize: number): string {
  return lines
    .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`)
    .join("");
}
