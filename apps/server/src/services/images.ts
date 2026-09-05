import { randomUUID } from "node:crypto";
import { mkdir, lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { DashboardDraft, WidgetDataEnvelope } from "@ink-stack/shared";
import { getWidgetDefinition } from "@ink-stack/widgets";
import { prepareImageAlbum, selectImage, type ImageWidgetConfig, type ManagedImageSource, type PreparedImageAlbum, type ImageWidgetData } from "@ink-stack/widgets/image/server";
import { decodeImagePng } from "./image-decoder.js";
import type { InkDatabase } from "../storage/database.js";

const uploadExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const maxUploadBytes = 16 * 1024 * 1024;
const sourceIdPattern = /^[A-Za-z0-9_-]{1,80}$/;

export type ImageSourcePublic = {
  id: string;
  type: "album" | "directory";
  name: string;
  revision: number;
  configured: true;
};

type ImageSourceRow = ImageSourcePublic & { root: string };
type CachedAlbum = { album: PreparedImageAlbum; selection?: { key: string; imageId: string } };

export class ImageManager {
  private readonly albums = new Map<string, CachedAlbum>();
  private readonly pending = new Map<string, Promise<PreparedImageAlbum>>();

  constructor(private readonly db: InkDatabase, private readonly directory: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.directory, "albums"), { recursive: true, mode: 0o700 });
  }

  list(): ImageSourcePublic[] {
    const rows = this.db.prepare("SELECT id,type,name,revision,root FROM image_sources ORDER BY name,id").all() as ImageSourceRow[];
    return rows.map((row) => this.public(row));
  }

  async create(input: { type: "album" | "directory"; name: string; root?: string }): Promise<ImageSourcePublic> {
    const name = input.name.trim().slice(0, 80);
    if (!name || !["album", "directory"].includes(input.type)) throw new Error("invalid_image_source");
    const id = randomUUID();
    let root: string;
    if (input.type === "album") {
      root = join(this.directory, "albums", id);
      await mkdir(root, { recursive: true, mode: 0o700 });
    } else {
      if (!input.root || !isAbsolute(input.root)) throw new Error("invalid_image_directory");
      const stat = await lstat(input.root).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid_image_directory");
      root = await realpath(input.root);
    }
    try {
      this.db.prepare("INSERT INTO image_sources(id,type,name,revision,root,created_at) VALUES (?,?,?,1,?,?)")
        .run(id, input.type, name, root, new Date().toISOString());
    } catch (error) {
      if (input.type === "album") await rm(root, { recursive: true, force: true });
      throw error;
    }
    return this.public(this.row(id)!);
  }

  async upload(id: string, filename: string, bytes: Buffer): Promise<{ source: ImageSourcePublic; filename: string }> {
    const row = this.row(id);
    if (!row || row.type !== "album") throw new Error("image_source_not_found");
    if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > maxUploadBytes) throw new Error("image_upload_too_large");
    const safeName = safeFilename(filename);
    if (!safeName || !uploadExtensions.has(extname(safeName).toLowerCase())) throw new Error("invalid_image_filename");
    const root = await this.safeRoot(row);
    const target = join(root, safeName);
    if (relative(root, target).startsWith(`..${sep}`) || relative(root, target) === "..") throw new Error("invalid_image_filename");
    if (await lstat(target).catch(() => undefined)) throw new Error("image_already_exists");
    const temporary = join(root, `.upload-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    this.invalidate(id);
    return { source: this.public(row), filename: safeName };
  }

  async listImages(id: string, revision: number, recursive: boolean): Promise<{ source: ImageSourcePublic; state: string; observedAt: string; skipped: number; images: Array<{ id: string; name: string; width: number; height: number }> }> {
    const row = this.row(id);
    if (!row || row.revision !== revision) throw new Error("image_source_not_found");
    const album = await this.prepare(row, recursive, new Date().toISOString());
    return {
      source: this.public(row), state: album.state, observedAt: album.observedAt, skipped: album.skipped,
      images: album.images.map(({ id: imageId, name, width, height }) => ({ id: imageId, name, width, height }))
    };
  }

  async collect(config: ImageWidgetConfig, widgetId: string, now: string): Promise<WidgetDataEnvelope<ImageWidgetData>> {
    const source = this.row(config.sourceId);
    if (!source || source.type !== config.sourceType || source.revision !== config.sourceRevision) {
      return { status: "unavailable", observedAt: now, data: { state: "unconfigured", count: 0, skipped: 0 } };
    }
    const scope = JSON.stringify([config.sourceType, config.sourceId, config.sourceRevision, config.recursive]);
    const previous = this.albums.get(scope);
    const album = await this.prepare(source, config.recursive, now);
    const savedRow = this.db.prepare("SELECT selection_key,image_id FROM image_selections WHERE widget_id=?").get(widgetId) as { selection_key: string; image_id: string } | undefined;
    const selected = selectImage({
      config, album, now, seed: widgetId,
      saved: savedRow ? { key: savedRow.selection_key, imageId: savedRow.image_id } : undefined,
      previous: previous?.selection ? { album: previous.album, selection: previous.selection } : undefined
    });
    if (selected.selection) {
      this.db.prepare("INSERT INTO image_selections(widget_id,selection_key,image_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(widget_id) DO UPDATE SET selection_key=excluded.selection_key,image_id=excluded.image_id,updated_at=excluded.updated_at")
        .run(widgetId, selected.selection.key, selected.selection.imageId, now);
    }
    this.albums.set(scope, { album, selection: selected.selection });
    return selected.envelope;
  }

  validate(dashboard: DashboardDraft): void {
    for (const widget of dashboard.widgets.filter((item) => item.type === "image")) {
      const config = widget.config as unknown as ImageWidgetConfig;
      if (config.sourceId === "unconfigured") continue;
      const row = this.row(config.sourceId);
      if (!row || row.type !== config.sourceType || row.revision !== config.sourceRevision) throw new Error("image_source_reference_invalid");
    }
  }

  remove(id: string, dashboards: DashboardDraft[]): void {
    if (dashboards.some((dashboard) => dashboard.widgets.some((widget) => widget.type === "image" && widget.config.sourceId === id))) throw new Error("image_source_in_use");
    const row = this.row(id);
    if (!row) throw new Error("image_source_not_found");
    this.db.prepare("DELETE FROM image_sources WHERE id=?").run(id);
    this.invalidate(id);
  }

  invalidate(id?: string): void {
    if (!id) { this.albums.clear(); return; }
    for (const key of this.albums.keys()) if (key.includes(`\"${id}\"`)) this.albums.delete(key);
  }

  private async prepare(row: ImageSourceRow, recursive: boolean, now: string): Promise<PreparedImageAlbum> {
    const definition = getWidgetDefinition("image");
    if (!definition) throw new Error("image_definition_missing");
    const config = { ...(definition.defaults as unknown as ImageWidgetConfig), sourceType: row.type, sourceId: row.id, sourceRevision: row.revision, recursive };
    const key = JSON.stringify([row.id, row.revision, recursive]);
    const active = this.pending.get(key);
    if (active) return active;
    const task = prepareImageAlbum({ config, sources: [this.managed(row)], now, decode: decodeImagePng })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private managed(row: ImageSourceRow): ManagedImageSource { return { id: row.id, type: row.type, revision: row.revision, root: row.root }; }

  private async safeRoot(row: ImageSourceRow): Promise<string> {
    const stat = await lstat(row.root).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("image_source_inaccessible");
    const root = await realpath(row.root);
    if (root !== row.root && !isWithin(row.root, root)) throw new Error("image_source_inaccessible");
    return root;
  }

  private row(id: string): ImageSourceRow | undefined {
    if (!sourceIdPattern.test(id)) return undefined;
    return this.db.prepare("SELECT id,type,name,revision,root FROM image_sources WHERE id=?").get(id) as ImageSourceRow | undefined;
  }

  private public(row: ImageSourceRow): ImageSourcePublic {
    const { root: _root, ...source } = row;
    return { ...source, configured: true };
  }
}

function safeFilename(value: string): string | undefined {
  if (typeof value !== "string" || !value || value.length > 180 || basename(value) !== value || /[\\/\x00-\x1f\x7f]/.test(value) || value === "." || value === "..") return undefined;
  return value;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
