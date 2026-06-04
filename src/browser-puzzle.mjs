import { decodePng } from "./png-decode-browser.mjs";

/** Decode canonical puzzle pixels from the committed PNG bytes. */
export async function pixelsFromPngUrl(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed to fetch puzzle image (${response.status})`);
  }
  const decoded = decodePng(new Uint8Array(await response.arrayBuffer()));
  return decoded.pixels;
}

/** @deprecated Canvas decode can diverge from the committed PNG bytes; prefer pixelsFromPngUrl. */
export function pixelsFromImage(image, width = 1024, height = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("canvas 2d context is unavailable");
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0, offset = 0; i < data.length; i += 4, offset += 3) {
    pixels[offset] = data[i];
    pixels[offset + 1] = data[i + 1];
    pixels[offset + 2] = data[i + 2];
  }
  return pixels;
}

export function waitForImage(image) {
  if (image.complete && image.naturalWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => reject(new Error("puzzle image failed to load")), {
      once: true,
    });
  });
}
