import { describe, expect, it } from "vitest";
import { validateWidgetInstanceConfig } from "../catalog.js";
import { renderWidgetToSvg } from "../registry.server.js";
import { renderImageWidget } from "./render.js";
import { selectImage, type PreparedImageAlbum } from "./server.js";
import type { ImageWidgetConfig, ImageWidgetData } from "./types.js";
import type { WidgetDataEnvelope } from "@ink-stack/shared";
import defaults from "./defaults.json" with { type: "json" };
import manifest from "./manifest.json" with { type: "json" };
import ready from "./fixtures/ready.json" with { type: "json" };
import empty from "./fixtures/empty.json" with { type: "json" };
import bad from "./fixtures/bad-images.json" with { type: "json" };
import inaccessible from "./fixtures/inaccessible.json" with { type: "json" };
import stale from "./fixtures/stale.json" with { type: "json" };

// Saved images without the new frame retain the original layout.
const config = { ...defaults, photoFrame: false, showTitle: true, showCaption: false, fit: "contain" } as ImageWidgetConfig;
const data = ready.data as WidgetDataEnvelope<ImageWidgetData>;
const instance = { id: "图片-1", type: "image", configVersion: 1, column: 0, row: 0, columnSpan: 2, rowSpan: 2, config };
const context = { now: "2026-09-05T00:00:00.000Z", timeZone: "Asia/Shanghai", screen: { width: 600, height: 800 }, rect: { x: 0, y: 0, width: 260, height: 240 } };
const images = ["a", "b", "c", "d"].map((char, index) => ({ ...data.data!.image!, id: char.repeat(64), name: `${index}.png` }));
const album: PreparedImageAlbum = { scope: JSON.stringify([config.sourceType, config.sourceId, config.sourceRevision, false]), fingerprint: "fixture-v1", state: "ready", observedAt: "1970-01-01T00:00:00.000Z", images, skipped: 0 };
const time = (slot: number) => new Date(slot * config.rotationSeconds * 1000).toISOString();
const select = (slot: number, override: Partial<Parameters<typeof selectImage>[0]> = {}) => selectImage({ config, album, now: time(slot), seed: "instance-1", ...override });

describe("image configuration and catalog", () => {
  it("validates defaults and rejects paths, URLs, unknown fields and incomplete fixed selection", () => {
    const validate = (patch: Record<string, unknown>) => validateWidgetInstanceConfig({ type: "image", configVersion: 1, config: { ...defaults, ...patch } as typeof defaults }).ok;
    expect(validate({})).toBe(true);
    for (const patch of [{ sourceId: "../../secret" }, { sourceId: "F:\\photos" }, { sourceId: "https://host/image.png" }, { path: "/tmp" }, { url: "file:///tmp" }, { selection: "fixed" }, { rotationSeconds: 0 }, { sourceRevision: 0 }, { recursive: "true" }, { padding: 99 }]) expect(validate(patch)).toBe(false);
    expect(validate({ selection: "fixed", fixedImageId: "a".repeat(64) })).toBe(true);
    expect(renderWidgetToSvg({ ...instance, config: defaults }, context, data)).toContain("data:image/png;base64,");
  });
});

describe("deterministic image rotation", () => {
  it("holds selection within a slot and reproduces output for the same inputs", () => {
    const first = select(10);
    expect(select(10)).toEqual(first);
    expect(select(10, { now: new Date(Date.parse(time(10)) + 3599_000).toISOString() })).toEqual(first);
    expect(select(10, { saved: first.selection })).toEqual(first);
  });
  it("visits every image once per random round and advances sequentially", () => {
    for (let round = 0; round < 6; round++) {
      const selected = Array.from({ length: 4 }, (_, i) => select(round * 4 + i).selection!.imageId);
      expect(new Set(selected).size).toBe(4);
    }
    for (let slot = 0; slot < 8; slot++) expect(select(slot, { config: { ...config, selection: "sequential" } }).selection!.imageId).toBe(images[slot % 4]!.id);
  });
  it("supports fixed images, missing fixed images and deterministic random with replacement", () => {
    const fixed = { ...config, selection: "fixed" as const, fixedImageId: images[2]!.id };
    expect(select(999, { config: fixed }).selection!.imageId).toBe(images[2]!.id);
    expect(select(0, { config: { ...fixed, fixedImageId: "e".repeat(64) } }).envelope.data?.state).toBe("missing-image");
    expect(select(20, { config: { ...config, noRepeat: false } })).toEqual(select(20, { config: { ...config, noRepeat: false } }));
  });
  it("keeps a persisted choice when rescanning adds an image and rejects mismatched policy keys", () => {
    const first = select(3);
    const changed = { ...album, fingerprint: "fixture-v2", images: [...images, { ...images[0]!, id: "e".repeat(64) }] };
    expect(select(3, { album: changed, saved: first.selection }).selection).toEqual(first.selection);
    const sequential = select(3, { config: { ...config, selection: "sequential" }, saved: first.selection });
    expect(sequential.selection!.imageId).toBe(images[3]!.id);
  });
  it("isolates old data by source revision, selection policy and bounded age", () => {
    const first = select(0);
    const previous = { album, selection: first.selection! };
    const failed = { ...album, state: "inaccessible" as const, images: [] };
    expect(select(1, { album: failed, previous }).envelope.status).toBe("stale");
    expect(select(25, { album: failed, previous }).envelope.status).toBe("unavailable");
    expect(select(1, { album: failed, previous, seed: "other" }).envelope.status).toBe("unavailable");
    expect(select(1, { album: { ...failed, state: "empty" }, previous }).envelope.status).toBe("unavailable");
    expect(() => select(1, { config: { ...config, sourceRevision: 2 }, previous })).toThrow("image_source_mismatch");
    expect(() => select(1, { now: "invalid" })).toThrow("invalid_render_time");
  });
});

describe("pure image layouts", () => {
  it.each(manifest.supportedSizes)("renders $columns × $rows with bounded, escaped text", ({ columns, rows }) => {
    const rect = { ...context.rect, width: columns * 120, height: rows * 110 };
    const input = { instance: { ...instance, columnSpan: columns, rowSpan: rows, config: { ...config, showCaption: true, title: "<相册>中文".repeat(40) } }, context: { ...context, rect }, data };
    const svg = renderImageWidget(input);
    expect(svg).toContain("&lt;相册&gt;");
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(svg).toContain('overflow="hidden"');
    expect(renderImageWidget(input)).toBe(svg);
    for (const match of svg.matchAll(/<text\b[^>]*\by="([\d.]+)"[^>]*\bfont-size="([\d.]+)"/g)) {
      expect(Number(match[1]) - Number(match[2])).toBeGreaterThanOrEqual(0);
      expect(Number(match[1]) + Number(match[2]) * 0.2).toBeLessThan(rect.height);
    }
  });
  it("reflows wide captions and uses unique grayscale filters for repeated instances", () => {
    const render = (id: string, columns: number, rows: number) => renderImageWidget({ instance: { ...instance, id, columnSpan: columns, rowSpan: rows, config: { ...config, showCaption: true } }, context, data });
    const wide = render("a-b", 4, 2);
    expect(wide).not.toBe(render("a_b", 4, 2));
    expect(wide.match(/<svg[^>]*width="([^"]+)"/)?.[1]).not.toBe(render("a-b", 4, 3).match(/<svg[^>]*width="([^"]+)"/)?.[1]);
  });
  it("distinguishes empty, corrupt, inaccessible and stale fixtures", () => {
    for (const [fixture, label] of [[empty, "相册暂无图片"], [bad, "图片无法解码"], [inaccessible, "相册暂不可访问"], [stale, "显示上次有效图片"]] as const) {
      expect(renderImageWidget({ instance, context, data: fixture.data as WidgetDataEnvelope<ImageWidgetData> })).toContain(label);
    }
  });
  it("rejects external image hrefs even in forged render data and honors unavailable status", () => {
    for (const href of ["file:///secret", "https://example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=", 'x" onload="alert(1)']) {
      const svg = renderImageWidget({ instance, context, data: { ...data, data: { ...data.data!, image: { ...images[0]!, pngDataUri: href } } } });
      expect(svg).not.toContain("<image ");
    }
    expect(renderImageWidget({ instance, context, data: { ...data, status: "unavailable" } })).not.toContain("<image ");
  });
});
