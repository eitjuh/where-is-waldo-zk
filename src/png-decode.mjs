import { inflateSync } from "./png-inflate.mjs";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(bufferLike) {
  const bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike);
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("not a PNG file");
    }
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts = [];

  while (offset < bytes.length) {
    const length = readU32(bytes, offset);
    const type = ascii(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = bytes.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error("only non-interlaced 8-bit RGB/RGBA PNG files are supported");
  }

  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const inflated = inflateSync(concat(idatParts));
  const scanlineLength = width * bytesPerPixel;
  const reconstructed = new Uint8Array(width * height * bytesPerPixel);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const row = inflated.subarray(inputOffset, inputOffset + scanlineLength);
    inputOffset += scanlineLength;

    const outOffset = y * scanlineLength;
    const previousOffset = y === 0 ? -1 : (y - 1) * scanlineLength;
    unfilterRow({
      filter,
      row,
      output: reconstructed,
      outOffset,
      previousOffset,
      scanlineLength,
      bytesPerPixel,
    });
  }

  const pixels = new Uint8Array(width * height * 3);
  if (colorType === 2) {
    pixels.set(reconstructed);
  } else {
    for (let src = 0, dst = 0; src < reconstructed.length; src += 4, dst += 3) {
      pixels[dst] = reconstructed[src];
      pixels[dst + 1] = reconstructed[src + 1];
      pixels[dst + 2] = reconstructed[src + 2];
    }
  }

  return { width, height, pixels };
}

function unfilterRow({
  filter,
  row,
  output,
  outOffset,
  previousOffset,
  scanlineLength,
  bytesPerPixel,
}) {
  for (let i = 0; i < scanlineLength; i += 1) {
    const raw = row[i];
    const left = i >= bytesPerPixel ? output[outOffset + i - bytesPerPixel] : 0;
    const up = previousOffset >= 0 ? output[previousOffset + i] : 0;
    const upLeft =
      previousOffset >= 0 && i >= bytesPerPixel ? output[previousOffset + i - bytesPerPixel] : 0;

    let value;
    if (filter === 0) {
      value = raw;
    } else if (filter === 1) {
      value = raw + left;
    } else if (filter === 2) {
      value = raw + up;
    } else if (filter === 3) {
      value = raw + Math.floor((left + up) / 2);
    } else if (filter === 4) {
      value = raw + paeth(left, up, upLeft);
    } else {
      throw new Error(`unsupported PNG filter ${filter}`);
    }

    output[outOffset + i] = value & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function ascii(bytes) {
  return new TextDecoder().decode(bytes);
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
