import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { afterEach, describe, expect, it } from "vitest";
import { prepareImageAlbum, type ManagedImageSource } from "@ink-stack/widgets/image/server";
import { renderImageWidget, type ImageWidgetConfig } from "@ink-stack/widgets/render";
import defaults from "../../../../packages/widgets/src/image/defaults.json" with { type: "json" };
import fixture from "../../../../packages/widgets/src/image/fixtures/ready.json" with { type: "json" };
import { decodeImagePng } from "./image-decoder.js";

const directories: string[] = [];
const config = defaults as ImageWidgetConfig;
const png = Buffer.from(fixture.data.data.image.pngDataUri.split(",")[1]!, "base64");
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ink-image-")); directories.push(root);
  const source: ManagedImageSource = { type: "album", id: config.sourceId, revision: 1, root };
  const scan = (patch: Partial<ImageWidgetConfig> = {}) => prepareImageAlbum({ config: { ...config, ...patch }, sources: [source], now: "2026-09-05T00:00:00.000Z", decode: decodeImagePng });
  return { root, source, scan };
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("controlled directory preparation", () => {
  it("scans optional subdirectories, skips corrupt images, sorts and returns no paths", async () => {
    const { root, scan } = await setup();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "z.PNG"), png);
    await writeFile(join(root, "a.png"), "bad image");
    await writeFile(join(root, "nested", "b.png"), png);
    expect((await scan()).images.map((image) => image.name)).toEqual(["z.PNG"]);
    const album = await scan({ recursive: true });
    expect(album.images.map((image) => image.name)).toEqual(["b.png", "z.PNG"]);
    expect(album.skipped).toBe(1);
    expect(JSON.stringify(album)).not.toContain(root);
    expect(album.fingerprint).toBe((await scan({ recursive: true })).fingerprint);
  });
  it("distinguishes empty, all-corrupt, missing and unknown sources", async () => {
    const { root, source, scan } = await setup();
    expect((await scan()).state).toBe("empty");
    await writeFile(join(root, "broken.jpg"), "bad");
    expect((await scan()).state).toBe("bad-images");
    expect((await scan({ sourceRevision: 2 })).state).toBe("unconfigured");
    const inaccessible = await prepareImageAlbum({ config, sources: [{ ...source, root: join(root, "missing") }], now: "2026-09-05T00:00:00Z", decode: decodeImagePng });
    expect(inaccessible.state).toBe("inaccessible");
    expect(JSON.stringify(inaccessible)).not.toContain(root);
  });
  it("skips directory junctions and hardlinks outside the approved root", async () => {
    const { root, scan } = await setup();
    const outside = await setup();
    await writeFile(join(outside.root, "secret.png"), png);
    await symlink(outside.root, join(root, "escape"), "junction");
    await link(join(outside.root, "secret.png"), join(root, "hardlink.png"));
    const album = await scan({ recursive: true });
    expect(album.images).toHaveLength(0);
    expect(album.skipped).toBe(1);
  });
  it("rejects invalid references before decoding and limits deep traversal", async () => {
    const { root, scan } = await setup();
    await expect(scan({ sourceId: "../../escape" })).rejects.toThrow("invalid_image_config");
    await mkdir(join(root, ...Array.from({ length: 10 }, () => "deep")), { recursive: true });
    expect((await scan({ recursive: true })).state).toBe("limit-exceeded");
  });
  it("never invokes the decoder for aborted scans or oversized source files", async () => {
    const { source } = await setup();
    let calls = 0;
    const scan = (signal?: AbortSignal) => prepareImageAlbum({ config, sources: [source], now: "2026-09-05T00:00:00Z", decode: async (bytes) => { calls++; return decodeImagePng(bytes); }, signal });
    await writeFile(join(source.root, "large.png"), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect((await scan()).state).toBe("bad-images");
    expect((await scan(AbortSignal.abort())).state).toBe("inaccessible");
    expect(calls).toBe(0);
  });
});

describe("image decoder and real SVG rasterization", () => {
  it("fully decodes allowed rasters and strips metadata, alpha, and excessive dimensions", async () => {
    const jpeg = await sharp({ create: { width: 3000, height: 10, channels: 4, background: "red" } }).withMetadata().jpeg().toBuffer();
    const result = await decodeImagePng(jpeg);
    const metadata = await sharp(result.png).metadata();
    expect(result.width).toBe(2048);
    expect(metadata.format).toBe("png");
    expect(metadata.hasAlpha).toBe(false);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    await expect(decodeImagePng(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'))).rejects.toThrow("unsupported_image");
    await expect(decodeImagePng(png.subarray(0, 30))).rejects.toThrow();
  });
  it("produces white letterboxing, fills cover and applies grayscale to actual pixels", async () => {
    const render = async (fit: "contain" | "cover", grayscale: boolean) => {
      const body = renderImageWidget({ instance: { id: "pixel", type: "image", configVersion: 1, column: 0, row: 0, columnSpan: 2, rowSpan: 2, config: { ...config, showTitle: false, showCaption: false, padding: 0, fit, grayscale } }, context: { now: "2026-09-05T00:00:00Z", timeZone: "UTC", screen: { width: 600, height: 800 }, rect: { x: 0, y: 0, width: 200, height: 200 } }, data: fixture.data as Parameters<typeof renderImageWidget>[0]["data"] });
      const output = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">${body}</svg>`).render().asPng();
      return sharp(output).removeAlpha().raw().toBuffer();
    };
    const pixel = (buffer: Buffer, x: number, y: number) => [...buffer.subarray((y * 200 + x) * 3, (y * 200 + x) * 3 + 3)];
    expect(pixel(await render("contain", false), 30, 20)).toEqual([255, 255, 255]);
    expect(pixel(await render("cover", false), 30, 20)).toEqual([255, 0, 0]);
    const gray = pixel(await render("cover", true), 30, 20);
    expect(gray[0]).toBe(gray[1]);
    expect(gray[1]).toBe(gray[2]);
    expect(gray[0]).toBeLessThan(255);
  });
});
