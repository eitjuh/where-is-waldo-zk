import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertAlignedCrop,
  bytesToHex,
  extractCropFromPixels,
  hexToBytes,
  inspectProofPrivacy,
  prettyJson,
  stableJson,
  textBytes,
} from "./shared-core.mjs";
import { buildMerkleTree, getMerklePath, splitTiles } from "./merkle.mjs";
import { decodePng } from "./png.mjs";
import { realCnnLogit } from "./quantized-cnn.mjs";

export const REAL_CONFIG = Object.freeze({
  defaultPuzzleId: "ski-slope",
  width: 1024,
  height: 1024,
  tileSize: 64,
  cropSize: 64,
  modelPath: "models/artifacts/waldo_cnn_quantized.json",
  privateCatalogPath: "demo/real/catalog.private.json",
  publicCatalogPath: "demo/real/catalog.json",
  puzzleArtifactRoot: "demo/real/puzzles",
  proofPath: "proofs/end_to_end_real.risc0.json",
});

export function realPuzzleConfig(puzzle, base = REAL_CONFIG) {
  return Object.freeze({
    ...base,
    puzzleId: puzzle.id,
    title: puzzle.title,
    imageId: `hey-waldo-real-${puzzle.id}`,
    imagePath: puzzle.image_path,
    commitmentPath: `${base.puzzleArtifactRoot}/${puzzle.id}/commitment.json`,
    witnessPath: `${base.puzzleArtifactRoot}/${puzzle.id}/witness.private.json`,
  });
}

export async function loadPrivateRealCatalog(path = REAL_CONFIG.privateCatalogPath) {
  const catalog = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(catalog.puzzles) || catalog.puzzles.length === 0) {
    throw new Error("real puzzle catalog is empty");
  }
  return catalog;
}

export async function loadRealModel(path = REAL_CONFIG.modelPath) {
  const model = JSON.parse(await readFile(path, "utf8"));
  const { model_hash: claimedModelHash, preprocessing_hash: claimedPreprocessingHash } = model;
  const modelHash = hashCanonicalJson(modelCommitment(model));
  const preprocessingHash = hashCanonicalJson(model.preprocessing);
  if (modelHash !== claimedModelHash) {
    throw new Error("real CNN model_hash does not match its canonical bundle");
  }
  if (preprocessingHash !== claimedPreprocessingHash) {
    throw new Error("real CNN preprocessing_hash does not match its canonical spec");
  }
  return model;
}

export async function loadRealPuzzle(path) {
  if (!path) {
    throw new Error("real puzzle path is required");
  }
  const png = decodePng(await readFile(path));
  if (png.width !== REAL_CONFIG.width || png.height !== REAL_CONFIG.height) {
    throw new Error(`expected ${REAL_CONFIG.width}x${REAL_CONFIG.height} real puzzle image`);
  }
  return png;
}

export function commitRealPixels({ pixels, model, config = REAL_CONFIG }) {
  const { tileColumns, tileRows, tiles } = splitTiles({
    pixels,
    width: config.width,
    height: config.height,
    tileSize: config.tileSize,
  });
  const tree = buildMerkleTree(tiles.map((tile) => tile.leaf));
  return {
    schema: "zk-waldo-image-commitment-v1",
    image_id: config.imageId,
    image_width: config.width,
    image_height: config.height,
    crop_width: config.cropSize,
    crop_height: config.cropSize,
    tile_size: config.tileSize,
    tile_columns: tileColumns,
    tile_rows: tileRows,
    leaf_count: tiles.length,
    hash_function: "sha256-domain-separated-v0",
    image_root: bytesToHex(tree.root),
    preprocessing_hash: model.preprocessing_hash,
  };
}

export function generateRealWitness({ pixels, commitment, x, y, config = REAL_CONFIG }) {
  assertAlignedCrop({
    x,
    y,
    imageWidth: config.width,
    imageHeight: config.height,
    cropSize: config.cropSize,
    tileSize: config.tileSize,
  });
  const { tileColumns, tiles } = splitTiles({
    pixels,
    width: config.width,
    height: config.height,
    tileSize: config.tileSize,
  });
  const tree = buildMerkleTree(tiles.map((tile) => tile.leaf));
  if (bytesToHex(tree.root) !== commitment.image_root) {
    throw new Error("real puzzle bytes do not match the public image commitment");
  }
  const tileX = x / config.tileSize;
  const tileY = y / config.tileSize;
  const leafIndex = tileY * tileColumns + tileX;
  const tile = tiles[leafIndex];
  const cropPixels = extractCropFromPixels(
    pixels,
    config.width,
    config.height,
    x,
    y,
    config.cropSize,
  );
  return {
    schema: "zk-waldo-private-witness-v1",
    x,
    y,
    crop_width: config.cropSize,
    crop_height: config.cropSize,
    crop_pixels: bytesToHex(cropPixels),
    tiles: [
      {
        tile_x: tileX,
        tile_y: tileY,
        leaf_index: leafIndex,
        pixels: bytesToHex(tile.pixels),
        merkle_path: getMerklePath(tree, leafIndex),
      },
    ],
  };
}

export async function prepareRealDemo({
  x,
  y,
  writeWitness = false,
  puzzleId = REAL_CONFIG.defaultPuzzleId,
  config,
} = {}) {
  if (!config) {
    const catalog = await loadPrivateRealCatalog();
    const puzzle = catalog.puzzles.find((entry) => entry.id === puzzleId);
    if (!puzzle) {
      throw new Error(`unknown real puzzle: ${puzzleId}`);
    }
    config = realPuzzleConfig(puzzle);
    x ??= puzzle.x;
    y ??= puzzle.y;
  }
  const [model, puzzle] = await Promise.all([loadRealModel(config.modelPath), loadRealPuzzle(config.imagePath)]);
  const commitment = commitRealPixels({ pixels: puzzle.pixels, model, config });
  await writeJson(config.commitmentPath, commitment);

  let witness;
  let logit;
  if (Number.isInteger(x) && Number.isInteger(y)) {
    witness = generateRealWitness({ pixels: puzzle.pixels, commitment, x, y, config });
    logit = realCnnLogit(hexToBytes(witness.crop_pixels), model);
    if (writeWitness) {
      await writeJson(config.witnessPath, witness);
    }
  }
  return { model, puzzle, commitment, witness, logit };
}

export async function prepareRealCatalog({ writeWitnesses = false } = {}) {
  const privateCatalog = await loadPrivateRealCatalog();
  const model = await loadRealModel();
  const puzzles = [];
  for (const entry of privateCatalog.puzzles) {
    const config = realPuzzleConfig(entry);
    const puzzle = await loadRealPuzzle(config.imagePath);
    const commitment = commitRealPixels({ pixels: puzzle.pixels, model, config });
    await writeJson(config.commitmentPath, commitment);
    const witness = generateRealWitness({
      pixels: puzzle.pixels,
      commitment,
      x: entry.x,
      y: entry.y,
      config,
    });
    const logit = realCnnLogit(hexToBytes(witness.crop_pixels), model);
    if (logit < model.threshold_logit) {
      throw new Error(`catalog Waldo target does not pass the CNN: ${entry.id}`);
    }
    if (writeWitnesses) {
      await writeJson(config.witnessPath, witness);
    }
    puzzles.push({ id: entry.id, title: entry.title, config, model, puzzle, commitment, witness, logit });
  }
  const publicCatalog = {
    schema: "zk-waldo-real-public-catalog-v1",
    default_puzzle_id: REAL_CONFIG.defaultPuzzleId,
    model_id: model.model_id,
    model_hash: model.model_hash,
    preprocessing_hash: model.preprocessing_hash,
    threshold_logit: model.threshold_logit,
    metrics: model.metrics,
    puzzles: puzzles.map((entry) => ({
      id: entry.id,
      title: entry.title,
      image_id: entry.commitment.image_id,
      image_path: entry.config.imagePath,
      image_root: entry.commitment.image_root,
    })),
  };
  await writeJson(REAL_CONFIG.publicCatalogPath, publicCatalog);
  return { model, puzzles, publicCatalog };
}

export function validateRealProofPrivacy(proof) {
  const hits = inspectProofPrivacy(proof);
  if (hits.length > 0) {
    throw new Error(`proof leaks private witness fields: ${hits.join(", ")}`);
  }
}

export function realPublicSummary({ commitment, model }) {
  return {
    image_id: commitment.image_id,
    image_root: commitment.image_root,
    model_id: model.model_id,
    model_hash: model.model_hash,
    preprocessing_hash: model.preprocessing_hash,
    threshold_logit: model.threshold_logit,
    dimensions: {
      image: [commitment.image_width, commitment.image_height],
      crop: [commitment.crop_width, commitment.crop_height],
      tile_size: commitment.tile_size,
      cnn_input: model.architecture.input,
    },
    metrics: model.metrics,
  };
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, prettyJson(value), "utf8");
}

function hashCanonicalJson(value) {
  return `0x${createHash("sha256").update(textBytes(stableJson(value))).digest("hex")}`;
}

function modelCommitment(model) {
  return Object.fromEntries(
    ["schema", "model_id", "architecture", "preprocessing", "weights", "threshold_logit"].map(
      (key) => [key, model[key]],
    ),
  );
}
