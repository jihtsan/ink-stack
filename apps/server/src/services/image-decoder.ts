import sharp from "sharp";
import type { DecodeImage } from "@ink-stack/widgets/image/server";

/** Only the server decodes files; SVG/GIF/animated and oversized inputs are rejected. */
export const decodeImagePng: DecodeImage = async (bytes) => {
  const signature = Buffer.from(bytes.subarray(0, 12));
  const raster = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff)
    || (signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP");
  if (!raster) throw new Error("unsupported_image");
  const image = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000 });
  const metadata = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new Error("unsupported_image");
  const result = await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).removeAlpha().png().timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
  return { png: result.data, width: result.info.width, height: result.info.height };
};
