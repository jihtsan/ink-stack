import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { WidgetDataEnvelope } from "@ink-stack/shared";
import { validateWidgetInstanceConfig } from "../catalog.js";
import { isSafeImageAsset, MAX_IMAGE_PNG_BYTES, type ImageAsset, type ImageState, type ImageWidgetConfig, type ImageWidgetData } from "./types.js";

/** Server-owned registry entry. Never construct root from widget config or return it to a browser. */
export interface ManagedImageSource {
  type: "album" | "directory";
  id: string;
  revision: number;
  root: string;
}

/** Must fully decode a raster, apply orientation, remove metadata and re-encode a bounded PNG. */
export type DecodeImage = (bytes: Uint8Array) => Promise<{ png: Uint8Array; width: number; height: number }>;

export interface PreparedImageAlbum {
  scope: string;
  fingerprint: string;
  observedAt: string;
  state: ImageState;
  images: readonly ImageAsset[];
  skipped: number;
}

export interface SavedImageSelection { key: string; imageId: string }
export interface ImageSelectionResult {
  envelope: WidgetDataEnvelope<ImageWidgetData>;
  selection?: SavedImageSelection;
}

export const IMAGE_SCAN_LIMITS = {
  entries: 2000, files: 128, depth: 8,
  fileBytes: 16 * 1024 * 1024, totalPngBytes: 32 * 1024 * 1024
} as const;
const extensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const scopeOf = (config: ImageWidgetConfig) => JSON.stringify([config.sourceType, config.sourceId, config.sourceRevision, config.recursive]);

function assertConfig(config: ImageWidgetConfig): void {
  if (!validateWidgetInstanceConfig({ type: "image", configVersion: 1, config: { ...config } }).ok) throw new Error("invalid_image_config");
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Produces a bounded immutable snapshot; the caller caches it across previews/rotation windows. */
export async function prepareImageAlbum(options: {
  config: ImageWidgetConfig;
  sources: readonly ManagedImageSource[];
  now: string;
  decode: DecodeImage;
  signal?: AbortSignal;
}): Promise<PreparedImageAlbum> {
  const { config, sources, now, decode, signal } = options;
  assertConfig(config);
  if (!Number.isFinite(Date.parse(now))) throw new Error("invalid_render_time");
  const scope = scopeOf(config);
  const result = (state: ImageState, images: ImageAsset[] = [], skipped = 0): PreparedImageAlbum => ({
    scope, observedAt: now, state, images, skipped,
    fingerprint: digest(JSON.stringify(images.map((image) => [image.id, digest(image.pngDataUri)])))
  });
  const source = sources.find((item) => item.type === config.sourceType && item.id === config.sourceId && item.revision === config.sourceRevision);
  if (!source) return result("unconfigured");
  if (!isAbsolute(source.root)) return result("inaccessible");
  const images: ImageAsset[] = [];
  let skipped = 0;
  let entries = 0;
  let files = 0;
  let totalBytes = 0;
  let failure: "limit-exceeded" | "inaccessible" | undefined;
  try {
    signal?.throwIfAborted();
    // Registry roots must themselves be real directories, not symlinks/junctions.
    if ((await lstat(source.root)).isSymbolicLink()) return result("inaccessible");
    const root = await realpath(source.root);
    const visit = async (directory: string, depth: number): Promise<void> => {
      signal?.throwIfAborted();
      if (!isWithin(root, await realpath(directory))) throw new Error("outside_source");
      const dir = await opendir(directory);
      for await (const entry of dir) {
        signal?.throwIfAborted();
        if (++entries > IMAGE_SCAN_LIMITS.entries) { failure = "limit-exceeded"; break; }
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory() && config.recursive) {
          if (depth >= IMAGE_SCAN_LIMITS.depth) { failure = "limit-exceeded"; break; }
          await visit(path, depth + 1);
        } else if (stat.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
          if (++files > IMAGE_SCAN_LIMITS.files) { failure = "limit-exceeded"; break; }
          try {
            if (stat.size <= 0 || stat.size > IMAGE_SCAN_LIMITS.fileBytes || stat.nlink !== 1) throw new Error("invalid_file");
            const resolved = await realpath(path);
            if (!isWithin(root, resolved)) throw new Error("outside_source");
            const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let bytes: Uint8Array;
            try {
              const opened = await handle.stat();
              if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.nlink !== 1) throw new Error("changed_file");
              // Read no more than the preflight size, even if a writer grows the file.
              const buffer = Buffer.alloc(stat.size + 1);
              let offset = 0;
              while (offset < buffer.length) {
                signal?.throwIfAborted();
                const read = await handle.read(buffer, offset, buffer.length - offset, offset);
                if (!read.bytesRead) break;
                offset += read.bytesRead;
              }
              if (offset !== stat.size) throw new Error("changed_file");
              bytes = buffer.subarray(0, offset);
            } finally { await handle.close(); }
            signal?.throwIfAborted();
            const decoded = await decode(bytes);
            signal?.throwIfAborted();
            if (decoded.png.length > MAX_IMAGE_PNG_BYTES) throw new Error("large_png");
            const image: ImageAsset = {
              id: digest(JSON.stringify([scope, relative(root, path).split(sep).join("/")])),
              name: basename(path).replace(/[\\/\x00-\x1f]/g, "_").slice(0, 240),
              pngDataUri: `data:image/png;base64,${Buffer.from(decoded.png).toString("base64")}`,
              width: decoded.width, height: decoded.height
            };
            if (!isSafeImageAsset(image)) throw new Error("invalid_decoded_image");
            if (totalBytes + decoded.png.length > IMAGE_SCAN_LIMITS.totalPngBytes) { failure = "limit-exceeded"; break; }
            totalBytes += decoded.png.length;
            images.push(image);
          } catch {
            signal?.throwIfAborted();
            skipped++;
          }
        }
        if (failure) break;
      }
    };
    await visit(root, 0);
  } catch { failure = "inaccessible"; }
  // A partial directory traversal is not a trustworthy new album inventory.
  if (failure) return result(failure, [], skipped);
  images.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id));
  return result(images.length ? "ready" : skipped ? "bad-images" : "empty", images, skipped);
}

/** Fixed inputs give fixed output. Never calls Math.random or the system clock. */
export function selectImage(options: {
  config: ImageWidgetConfig;
  album: PreparedImageAlbum;
  now: string;
  seed: string;
  saved?: SavedImageSelection;
  previous?: { album: PreparedImageAlbum; selection: SavedImageSelection };
  maxStaleMs?: number;
}): ImageSelectionResult {
  const { config, album, now, seed, saved, previous } = options;
  assertConfig(config);
  const time = Date.parse(now);
  if (!Number.isFinite(time) || time < 0) throw new Error("invalid_render_time");
  if (album.scope !== scopeOf(config)) throw new Error("image_source_mismatch");
  const unavailable = (state: ImageState): ImageSelectionResult => ({ envelope: {
    status: "unavailable", observedAt: album.observedAt,
    data: { state, count: 0, skipped: album.skipped }
  } });
  const policy = JSON.stringify([album.scope, seed, config.selection, config.fixedImageId, config.rotationSeconds, config.noRepeat]);
  const slot = Math.floor(time / (config.rotationSeconds * 1000));
  const prefix = digest(policy);
  const key = `${prefix}:${config.selection === "fixed" ? "fixed" : slot}`;
  if (album.state !== "ready") {
    const oldAlbum = previous?.album;
    const age = oldAlbum ? time - Date.parse(oldAlbum.observedAt) : NaN;
    const oldImage = oldAlbum?.images.find((image) => image.id === previous?.selection.imageId);
    const budget = options.maxStaleMs ?? 86_400_000;
    if (["inaccessible", "limit-exceeded"].includes(album.state) && oldAlbum?.scope === album.scope
      && previous?.selection.key.startsWith(`${prefix}:`) && oldImage && isSafeImageAsset(oldImage)
      && age >= 0 && Number.isFinite(budget) && budget >= 0 && age <= budget) {
      return { selection: previous.selection, envelope: { status: "stale", observedAt: oldAlbum.observedAt,
        data: { state: album.state, image: oldImage, count: oldAlbum.images.length, skipped: album.skipped } } };
    }
    return unavailable(album.state);
  }
  if (!album.images.length) return unavailable("empty");
  let image = saved?.key === key ? album.images.find((candidate) => candidate.id === saved.imageId) : undefined;
  if (!image) {
    if (config.selection === "fixed") image = album.images.find((candidate) => candidate.id === config.fixedImageId);
    else if (config.selection === "sequential") image = album.images[slot % album.images.length];
    else {
      const cycle = config.noRepeat ? Math.floor(slot / album.images.length) : slot;
      const order = album.images.map((candidate) => ({ candidate, rank: digest(JSON.stringify([policy, album.fingerprint, cycle, candidate.id])) }))
        .sort((a, b) => a.rank.localeCompare(b.rank) || a.candidate.id.localeCompare(b.candidate.id));
      image = order[config.noRepeat ? slot % order.length : 0]?.candidate;
    }
  }
  if (!image || !isSafeImageAsset(image)) return unavailable("missing-image");
  return { selection: { key, imageId: image.id }, envelope: {
    status: "fresh", observedAt: album.observedAt,
    data: { state: "ready", image, count: album.images.length, skipped: album.skipped }
  } };
}
