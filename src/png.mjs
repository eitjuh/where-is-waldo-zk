import { deflateSync } from "node:zlib";
import { decodePng as decodePngImpl } from "./png-decode.mjs";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function encodePngRgb({ width, height, pixels }) {
  if (pixels.length !== width * height * 3) {
    throw new Error("RGB pixel buffer has the wrong length");
  }

  const scanlineLength = width * 3;
  const raw = new Uint8Array((scanlineLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (scanlineLength + 1);
    raw[rowOffset] = 0;
    raw.set(pixels.subarray(y * scanlineLength, (y + 1) * scanlineLength), rowOffset + 1);
  }

  return concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

export function decodePng(bufferLike) {
  return decodePngImpl(bufferLike);
}

function ihdr(width, height) {
  const out = new Uint8Array(13);
  writeU32(out, 0, width);
  writeU32(out, 4, height);
  out[8] = 8;
  out[9] = 2;
  out[10] = 0;
  out[11] = 0;
  out[12] = 0;
  return out;
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(concat([typeBytes, data])));
  return out;
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value >>> 0, false);
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

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
