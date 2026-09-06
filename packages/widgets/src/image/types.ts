export interface ImageWidgetConfig {
  title: string;
  sourceType: "album" | "directory";
  sourceId: string;
  sourceRevision: number;
  recursive: boolean;
  selection: "random" | "sequential" | "fixed";
  fixedImageId: string;
  rotationSeconds: number;
  noRepeat: boolean;
  fit: "contain" | "cover";
  grayscale: boolean;
  showTitle: boolean;
  showCaption: boolean;
  photoFrame?: boolean;
  caption?: string;
  showBorder: boolean;
  padding: number;
}

/** Only a server-decoded, metadata-stripped PNG may cross the render boundary. */
export interface ImageAsset {
  id: string;
  name: string;
  pngDataUri: string;
  width: number;
  height: number;
}

export type ImageState = "ready" | "unconfigured" | "empty" | "bad-images" | "inaccessible" | "missing-image" | "limit-exceeded";

export interface ImageWidgetData {
  state: ImageState;
  image?: ImageAsset;
  count: number;
  skipped: number;
}

export const MAX_IMAGE_PNG_BYTES = 8 * 1024 * 1024;

/** Defense in depth: never emit arbitrary hrefs, SVG, file paths or network URLs. */
export function isSafeImageAsset(value: unknown): value is ImageAsset {
  if (!value || typeof value !== "object") return false;
  const image = value as ImageAsset;
  return typeof image.id === "string" && /^[a-f0-9]{64}$/.test(image.id)
    && typeof image.name === "string" && image.name.length <= 240 && !/[\\/\x00-\x1f]/.test(image.name)
    && Number.isInteger(image.width) && image.width > 0 && image.width <= 2048
    && Number.isInteger(image.height) && image.height > 0 && image.height <= 2048
    && typeof image.pngDataUri === "string" && image.pngDataUri.length <= Math.ceil(MAX_IMAGE_PNG_BYTES / 3) * 4 + 22
    && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(image.pngDataUri);
}
