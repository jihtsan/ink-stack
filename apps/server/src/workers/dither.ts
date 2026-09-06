import type { WidgetRenderRect } from "@ink-stack/shared";

/** Floyd–Steinberg error diffusion stays inside one widget's pixel rectangle. */
export function ditherRect(pixels: Uint8Array, imageWidth: number, rect: WidgetRenderRect): void {
  const { x, y, width, height } = rect;
  const work = new Float32Array(width * height);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) work[row * width + col] = pixels[(y + row) * imageWidth + x + col]!;
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const index = row * width + col;
    const old = work[index]!;
    const next = Math.round(Math.max(0, Math.min(255, old)) / 17) * 17;
    pixels[(y + row) * imageWidth + x + col] = next;
    const error = old - next;
    if (col + 1 < width) work[index + 1]! += error * 7 / 16;
    if (row + 1 < height) {
      if (col > 0) work[index + width - 1]! += error * 3 / 16;
      work[index + width]! += error * 5 / 16;
      if (col + 1 < width) work[index + width + 1]! += error / 16;
    }
  }
}
