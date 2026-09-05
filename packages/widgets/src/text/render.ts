import type { WidgetRenderInput } from "../types.js";
import { escapeXml, fitText, renderScale, scaled, wrapTextToWidth } from "../render-utils.js";

export interface TextWidgetConfig {
  title: string;
  text: string;
  size: "small" | "medium" | "large";
  align: "left" | "center" | "right";
  showBorder: boolean;
  showBackground: boolean;
}

export function renderTextWidget(input: WidgetRenderInput<TextWidgetConfig>): string {
  const { rect, screen } = input.context;
  const { title, text, size, align, showBorder, showBackground } = input.instance.config;
  const scale = Math.min(renderScale(screen), rect.height / (title ? 100 : 65), rect.width / 150);
  const padding = scaled(14, scale);
  const fontSize = scaled(size === "large" ? 26 : size === "small" ? 16 : 20, scale);
  const lineHeight = Math.round(fontSize * 1.35);
  const titleBaseline = scaled(27, scale);
  const bodyBaseline = scaled(title ? 58 : 28, scale);
  const maxLines = Math.max(0, Math.floor((rect.height - padding - fontSize * 0.2 - bodyBaseline) / lineHeight) + 1);
  const lines = wrapTextToWidth(text, rect.width - padding * 2, fontSize, maxLines);
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const x = align === "center" ? rect.width / 2 : align === "right" ? rect.width - padding : padding;
  const background = showBackground
    ? `<rect x="${scale}" y="${scale}" width="${rect.width - scale * 2}" height="${rect.height - scale * 2}" rx="${scaled(10, scale)}" fill="#ffffff"/>`
    : "";
  const border = showBorder
    ? `<rect x="${scale}" y="${scale}" width="${rect.width - scale * 2}" height="${rect.height - scale * 2}" rx="${scaled(10, scale)}" fill="none" stroke="#b8b8b8" stroke-width="${scale}"/>`
    : "";
  const titleText = title
    ? `<text x="${x}" y="${titleBaseline}" text-anchor="${anchor}" font-size="${scaled(16, scale)}" font-weight="700">${escapeXml(fitText(title, rect.width - padding * 2, scaled(16, scale)))}</text>`
    : "";
  const body = lines
    .map((line, index) => `<text x="${x}" y="${bodyBaseline + index * lineHeight}" font-size="${fontSize}" text-anchor="${anchor}">${escapeXml(line)}</text>`)
    .join("");

  return `${background}${border}${titleText}${body}`;
}
