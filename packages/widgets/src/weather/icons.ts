import icons from "./icons.json" with { type: "json" };

/** Google Material Symbols, Apache-2.0; see README for source and license. */
export function weatherIcon(condition: string, x: number, y: number, size: number, style: "outline" | "dot" | "solid", id: string): string {
  const name = /雪/.test(condition) ? "weather_snowy" : /雨/.test(condition) ? "rainy" : /多云/.test(condition) ? "partly_cloudy_day" : /阴|雾/.test(condition) ? "cloud" : /晴/.test(condition) ? "sunny" : undefined;
  if (!name) return "";
  const source = icons[name][style === "outline" ? "outline" : "solid"];
  const viewBox = source.match(/viewBox="([^"]+)"/)![1];
  const body = source.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const uid = Array.from(id).map(c => c.codePointAt(0)!.toString(16)).join("-");
  if (style !== "dot") return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBox}">${body}</svg>`;
  // Apply a dot screen to the actual library glyph, never substitute a drawn icon.
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBox}"><defs><pattern id="dots-${uid}" width="60" height="60" patternUnits="userSpaceOnUse"><circle cx="30" cy="30" r="25" fill="#222222"/></pattern><clipPath id="glyph-${uid}">${body}</clipPath></defs><rect x="0" y="-960" width="960" height="1920" fill="url(#dots-${uid})" clip-path="url(#glyph-${uid})"/></svg>`;
}
