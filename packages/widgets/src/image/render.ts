import type { WidgetRenderInput } from "../types.js";
import { escapeXml, fitText, renderScale, scaled } from "../render-utils.js";
import { isSafeImageAsset, type ImageState, type ImageWidgetConfig, type ImageWidgetData } from "./types.js";

const stateLabels: Record<ImageState, string> = {
  ready: "图片不可用", unconfigured: "请选择相册", empty: "相册暂无图片",
  "bad-images": "图片无法解码", inaccessible: "相册暂不可访问",
  "missing-image": "所选图片已移除", "limit-exceeded": "相册超出扫描限制"
};

export function renderImageWidget(input: WidgetRenderInput<ImageWidgetConfig, ImageWidgetData>): string {
  const { rect, screen } = input.context;
  const config = input.instance.config;
  const data = input.data?.data;
  const scale = Math.min(renderScale(screen), rect.width / 160, rect.height / 120);
  const font = scaled(16, scale);
  const inset = Math.max(scaled(config.padding, scale), 1);
  const titleHeight = config.showTitle && config.title ? scaled(32, scale) : 0;
  const stale = input.data?.status === "stale";
  const canShowImage = input.data && ["fresh", "stale"].includes(input.data.status) && isSafeImageAsset(data?.image);
  const image = canShowImage ? data!.image! : undefined;
  const showCaption = config.showCaption && image;
  const footerHeight = stale || showCaption || (data?.skipped ?? 0) > 0 ? scaled(28, scale) : 0;
  // Wide cards move the caption alongside the image; taller cards reserve a footer.
  const sideCaption = !!showCaption && input.instance.columnSpan === 4 && input.instance.rowSpan === 2;
  const sidebar = sideCaption ? Math.round(rect.width * 0.25) : 0;
  const width = Math.max(1, rect.width - inset * 2 - sidebar);
  const height = Math.max(1, rect.height - inset * 2 - titleHeight - footerHeight);
  let svg = `<rect width="${rect.width}" height="${rect.height}" fill="#ffffff"/>`;
  if (config.showTitle && config.title) svg += `<text x="${inset}" y="${inset + font}" font-size="${font}" font-weight="700">${escapeXml(fitText(config.title, rect.width - inset * 2, font))}</text>`;
  if (image) {
    // UTF-16 hex encoding is injective and keeps duplicate instances' filter IDs distinct.
    const filterId = `image-gray-${Array.from({ length: input.instance.id.length }, (_, i) => input.instance.id.charCodeAt(i).toString(16).padStart(4, "0")).join("")}`;
    if (config.grayscale) svg += `<defs><filter id="${filterId}" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter></defs>`;
    svg += `<svg x="${inset}" y="${inset + titleHeight}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden"><image width="${width}" height="${height}" preserveAspectRatio="xMidYMid ${config.fit === "cover" ? "slice" : "meet"}" href="${image.pngDataUri}"${config.grayscale ? ` filter="url(#${filterId})"` : ""}/></svg>`;
    if (showCaption) {
      const captionWidth = sideCaption ? sidebar - inset : width;
      const x = sideCaption ? inset + width + inset : inset;
      const y = sideCaption ? inset + titleHeight + font : rect.height - inset - scaled(5, scale);
      svg += `<text x="${x}" y="${y}" font-size="${font}">${escapeXml(fitText(image.name, captionWidth, font))}</text>`;
    }
  } else {
    const label = stateLabels[data?.state ?? "unconfigured"] ?? "图片不可用";
    svg += `<text x="${rect.width / 2}" y="${inset + titleHeight + height / 2}" text-anchor="middle" font-size="${font}">${escapeXml(fitText(label, width, font))}</text>`;
  }
  if (stale || (data?.skipped ?? 0) > 0) {
    const label = stale ? "显示上次有效图片" : `已跳过 ${data!.skipped} 张无效图片`;
    // Status takes priority over the bottom caption; move it to the image's lower edge.
    svg += `<rect x="${inset}" y="${rect.height - inset - footerHeight}" width="${rect.width - inset * 2}" height="${footerHeight}" fill="#ffffff"/><text x="${inset}" y="${rect.height - inset - scaled(5, scale)}" font-size="${font}">${escapeXml(fitText(label, rect.width - inset * 2, font))}</text>`;
  }
  if (config.showBorder) svg += `<rect x="1" y="1" width="${Math.max(0, rect.width - 2)}" height="${Math.max(0, rect.height - 2)}" fill="none" stroke="#000000"/>`;
  return svg;
}
