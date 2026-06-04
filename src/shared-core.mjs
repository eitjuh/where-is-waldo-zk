export const PROTOCOL_VERSION = "zk-waldo-demo-v0";
export const PROOF_BACKEND = "demo-local-attestation-v0";
export const HASH_FUNCTION = "sha256_domain_separated_demo_v0";
export const DEMO_ATTESTATION_KEY =
  "zk-waldo demo attestation key; public and non-production";

export const DEMO_CONFIG = Object.freeze({
  imageId: "synthetic_puzzle_001",
  width: 512,
  height: 384,
  tileSize: 32,
  cropSize: 64,
  targetX: 224,
  targetY: 160,
  thresholdLogit: 700,
});

export const COLORS = Object.freeze({
  background: [242, 238, 220],
  ink: [30, 34, 40],
  red: [206, 34, 46],
  white: [248, 246, 235],
  blue: [42, 89, 176],
  skin: [238, 183, 132],
  green: [71, 150, 109],
  yellow: [226, 186, 66],
  purple: [112, 82, 159],
});

export function stableJson(value) {
  return JSON.stringify(sortForJson(value));
}

export function prettyJson(value) {
  return `${JSON.stringify(sortForJson(value), null, 2)}\n`;
}

function sortForJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortForJson(value[key]);
    }
    return out;
  }

  return value;
}

export function textBytes(text) {
  return new TextEncoder().encode(text);
}

export function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u32be(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`expected uint32, got ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function int32be(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(`expected int32, got ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

export function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error(`invalid hex string: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function makePixels(width, height, color = COLORS.background) {
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
  }
  return pixels;
}

export function setPixel(pixels, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const offset = (y * width + x) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

export function fillRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + rectWidth);
  const y1 = Math.min(height, y + rectHeight);

  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      setPixel(pixels, width, height, px, py, color);
    }
  }
}

export function fillCircle(pixels, width, height, centerX, centerY, radius, color) {
  const r2 = radius * radius;
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= r2) {
        setPixel(pixels, width, height, x, y, color);
      }
    }
  }
}

export function generateSyntheticPuzzle(config = DEMO_CONFIG) {
  const { width, height, targetX, targetY } = config;
  const pixels = makePixels(width, height);
  drawBackgroundPattern(pixels, width, height);
  drawCrowd(pixels, width, height, config);
  drawTargetCharacter(pixels, width, height, targetX, targetY);

  return {
    imageId: config.imageId,
    width,
    height,
    pixels,
    target: { x: targetX, y: targetY, cropSize: config.cropSize },
  };
}

function drawBackgroundPattern(pixels, width, height) {
  for (let y = 0; y < height; y += 16) {
    const color = y % 32 === 0 ? [236, 231, 210] : [247, 242, 224];
    fillRect(pixels, width, height, 0, y, width, 8, color);
  }

  for (let x = 0; x < width; x += 64) {
    fillRect(pixels, width, height, x, 0, 2, height, [226, 220, 201]);
  }
}

function drawCrowd(pixels, width, height, config) {
  const rng = lcg(0x51f15e);
  const palettes = [
    [COLORS.green, COLORS.yellow],
    [COLORS.purple, COLORS.green],
    [COLORS.yellow, COLORS.blue],
    [COLORS.red, COLORS.green],
    [COLORS.white, COLORS.purple],
    [COLORS.red, COLORS.white],
  ];

  for (let i = 0; i < 130; i += 1) {
    const x = 8 + Math.floor(rng() * (width - 28));
    const y = 14 + Math.floor(rng() * (height - 58));
    if (overlapsTargetCrop(x, y, config)) {
      continue;
    }

    const palette = palettes[Math.floor(rng() * palettes.length)];
    const hasHat = rng() > 0.55;
    const hasStripes = rng() > 0.72;
    const pants = rng() > 0.45 ? COLORS.ink : palette[1];
    drawSmallPerson(pixels, width, height, x, y, {
      shirtA: palette[0],
      shirtB: palette[1],
      pants,
      hasHat,
      hasStripes,
      scale: 0.75 + rng() * 0.45,
    });
  }
}

function overlapsTargetCrop(x, y, config) {
  const margin = 12;
  return (
    x >= config.targetX - margin &&
    x <= config.targetX + config.cropSize + margin &&
    y >= config.targetY - margin &&
    y <= config.targetY + config.cropSize + margin
  );
}

function drawSmallPerson(pixels, width, height, x, y, options) {
  const scale = options.scale;
  const w = Math.round(14 * scale);
  const h = Math.round(34 * scale);
  const headRadius = Math.max(3, Math.round(5 * scale));
  const centerX = x + Math.round(w / 2);

  if (options.hasHat) {
    fillRect(pixels, width, height, centerX - headRadius, y, headRadius * 2, 3, options.shirtA);
  }

  fillCircle(pixels, width, height, centerX, y + 7, headRadius, COLORS.skin);

  const shirtY = y + 13;
  const shirtH = Math.max(8, Math.round(12 * scale));
  if (options.hasStripes) {
    for (let sx = 0; sx < w; sx += 3) {
      const color = Math.floor(sx / 3) % 2 === 0 ? options.shirtA : options.shirtB;
      fillRect(pixels, width, height, x + sx, shirtY, Math.min(3, w - sx), shirtH, color);
    }
  } else {
    fillRect(pixels, width, height, x, shirtY, w, shirtH, options.shirtA);
  }

  fillRect(pixels, width, height, x + 2, shirtY + shirtH, Math.max(3, Math.floor(w / 3)), h - shirtH - 12, options.pants);
  fillRect(
    pixels,
    width,
    height,
    x + Math.floor(w / 2),
    shirtY + shirtH,
    Math.max(3, Math.floor(w / 3)),
    h - shirtH - 12,
    options.pants,
  );
}

export function drawTargetCharacter(pixels, width, height, cropX, cropY) {
  const x = cropX;
  const y = cropY;

  fillRect(pixels, width, height, x + 23, y + 7, 20, 7, COLORS.red);
  fillRect(pixels, width, height, x + 19, y + 13, 28, 4, COLORS.red);
  fillCircle(pixels, width, height, x + 44, y + 8, 3, COLORS.white);

  fillCircle(pixels, width, height, x + 33, y + 22, 9, COLORS.skin);
  fillRect(pixels, width, height, x + 24, y + 19, 18, 3, COLORS.ink);
  fillRect(pixels, width, height, x + 27, y + 18, 5, 5, COLORS.ink);
  fillRect(pixels, width, height, x + 35, y + 18, 5, 5, COLORS.ink);

  for (let sx = 20; sx < 44; sx += 4) {
    const color = Math.floor((sx - 20) / 4) % 2 === 0 ? COLORS.red : COLORS.white;
    fillRect(pixels, width, height, x + sx, y + 30, 4, 15, color);
  }
  fillRect(pixels, width, height, x + 19, y + 30, 26, 3, COLORS.ink);
  fillRect(pixels, width, height, x + 18, y + 34, 4, 9, COLORS.red);
  fillRect(pixels, width, height, x + 43, y + 34, 4, 9, COLORS.red);

  fillRect(pixels, width, height, x + 23, y + 45, 9, 14, COLORS.blue);
  fillRect(pixels, width, height, x + 35, y + 45, 9, 14, COLORS.blue);
  fillRect(pixels, width, height, x + 22, y + 58, 11, 3, COLORS.ink);
  fillRect(pixels, width, height, x + 34, y + 58, 11, 3, COLORS.ink);
}

export function extractCropFromPixels(pixels, imageWidth, imageHeight, x, y, cropSize) {
  if (x < 0 || y < 0 || x + cropSize > imageWidth || y + cropSize > imageHeight) {
    throw new Error(`crop ${x},${y},${cropSize} is out of bounds`);
  }

  const crop = new Uint8Array(cropSize * cropSize * 3);
  for (let row = 0; row < cropSize; row += 1) {
    const srcStart = ((y + row) * imageWidth + x) * 3;
    const srcEnd = srcStart + cropSize * 3;
    crop.set(pixels.subarray(srcStart, srcEnd), row * cropSize * 3);
  }
  return crop;
}

export function quantizedDetectorLogit(cropPixels, cropSize = DEMO_CONFIG.cropSize) {
  if (cropPixels.length !== cropSize * cropSize * 3) {
    throw new Error(`expected ${cropSize}x${cropSize} RGB crop`);
  }

  const features = {
    hat: regionColorScore(cropPixels, cropSize, 23, 7, 20, 8, COLORS.red),
    face: regionColorScore(cropPixels, cropSize, 25, 15, 16, 13, COLORS.skin),
    glasses: regionColorScore(cropPixels, cropSize, 24, 18, 18, 5, COLORS.ink),
    stripes: stripeScore(cropPixels, cropSize),
    pants: regionColorScore(cropPixels, cropSize, 23, 45, 21, 14, COLORS.blue),
  };

  const logit =
    features.hat * 2 +
    features.face +
    features.glasses +
    features.stripes * 3 +
    features.pants * 2 -
    1250;

  return { logit: Math.round(logit), features };
}

function stripeScore(cropPixels, cropSize) {
  let total = 0;
  let count = 0;
  for (let y = 30; y < 45; y += 1) {
    for (let x = 20; x < 44; x += 1) {
      const stripe = Math.floor((x - 20) / 4) % 2;
      const expected = stripe === 0 ? COLORS.red : COLORS.white;
      total += colorScoreAt(cropPixels, cropSize, x, y, expected);
      count += 1;
    }
  }
  return Math.round(total / count);
}

function regionColorScore(cropPixels, cropSize, x, y, width, height, expected) {
  let total = 0;
  let count = 0;
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      total += colorScoreAt(cropPixels, cropSize, px, py, expected);
      count += 1;
    }
  }
  return Math.round(total / count);
}

function colorScoreAt(pixels, width, x, y, expected) {
  const offset = (y * width + x) * 3;
  const dr = Math.abs(pixels[offset] - expected[0]);
  const dg = Math.abs(pixels[offset + 1] - expected[1]);
  const db = Math.abs(pixels[offset + 2] - expected[2]);
  return Math.max(0, 255 - Math.round((dr + dg + db) / 3));
}

export function defaultModelBundle() {
  return {
    schema: "zk-waldo-model-bundle-v0",
    model_id: "target_character_tiny_int_detector_v0",
    model_family: "handcrafted integer CNN-style region detector",
    input: {
      width: DEMO_CONFIG.cropSize,
      height: DEMO_CONFIG.cropSize,
      channels: 3,
      pixel_type: "uint8",
      layout: "row-major-rgb",
    },
    preprocessing: preprocessingSpec(),
    ops: [
      "fixed RGB color feature maps",
      "region average pooling",
      "integer dense logit",
      "threshold comparison without sigmoid",
    ],
    weights: {
      hat_red: 2,
      face_skin: 1,
      glasses_black: 1,
      shirt_stripes: 3,
      pants_blue: 2,
      bias: -1250,
    },
    threshold_logit: DEMO_CONFIG.thresholdLogit,
    note:
      "This bundle is deterministic and integer-only for the local protocol demo. Replace with exported quantized CNN weights for production ZK.",
  };
}

export function preprocessingSpec(config = DEMO_CONFIG) {
  return {
    schema: "zk-waldo-preprocessing-v0",
    accepted_input: "png-rgb-or-rgba",
    canonical_pixels: "rgb-uint8-row-major",
    image_width: config.width,
    image_height: config.height,
    tile_size: config.tileSize,
    crop_width: config.cropSize,
    crop_height: config.cropSize,
    crop_alignment: "tile-aligned-top-left",
    resize: "reject-dimension-mismatch",
  };
}

export function makePublicInputs({ commitment, modelHash, thresholdLogit }) {
  return {
    image_root: commitment.image_root,
    model_hash: modelHash,
    preprocessing_hash: commitment.preprocessing_hash,
    threshold_logit: thresholdLogit,
    image_width: commitment.image_width,
    image_height: commitment.image_height,
    crop_width: commitment.crop_width,
    crop_height: commitment.crop_height,
    tile_size: commitment.tile_size,
  };
}

export function inspectProofPrivacy(proof) {
  const forbiddenKeys = new Set([
    "x",
    "y",
    "crop",
    "crop_pixels",
    "cropPixels",
    "tile",
    "tiles",
    "tile_pixels",
    "tilePixels",
    "tile_x",
    "tile_y",
    "tileX",
    "tileY",
    "leaf_index",
    "leafIndex",
    "sibling",
    "siblings",
    "merkle_path",
    "merklePath",
    "path_directions",
    "pathDirections",
    "witness",
    "privateWitness",
  ]);

  const hits = [];
  function visit(value, path) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) {
        hits.push(`${path}.${key}`);
      }
      visit(child, `${path}.${key}`);
    }
  }

  visit(proof, "$");
  return hits;
}

export function assertAlignedCrop({ x, y, imageWidth, imageHeight, cropSize, tileSize }) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error("crop coordinates must be integers");
  }
  if (x < 0 || y < 0 || x + cropSize > imageWidth || y + cropSize > imageHeight) {
    throw new Error("crop is out of bounds");
  }
  if (x % tileSize !== 0 || y % tileSize !== 0) {
    throw new Error(`MVP requires tile-aligned crops (${tileSize}px alignment)`);
  }
}

export function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function pixelBytesToRgba(rgbPixels) {
  const rgba = new Uint8ClampedArray((rgbPixels.length / 3) * 4);
  for (let src = 0, dst = 0; src < rgbPixels.length; src += 3, dst += 4) {
    rgba[dst] = rgbPixels[src];
    rgba[dst + 1] = rgbPixels[src + 1];
    rgba[dst + 2] = rgbPixels[src + 2];
    rgba[dst + 3] = 255;
  }
  return rgba;
}
