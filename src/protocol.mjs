import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEMO_ATTESTATION_KEY,
  DEMO_CONFIG,
  HASH_FUNCTION,
  PROOF_BACKEND,
  PROTOCOL_VERSION,
  assertAlignedCrop,
  bytesToHex,
  defaultModelBundle,
  extractCropFromPixels,
  generateSyntheticPuzzle,
  hexToBytes,
  inspectProofPrivacy,
  makePublicInputs,
  preprocessingSpec,
  prettyJson,
  quantizedDetectorLogit,
  stableJson,
  textBytes,
} from "./shared-core.mjs";
import { decodePng, encodePngRgb } from "./png.mjs";
import {
  buildMerkleTree,
  getMerklePath,
  hashTile,
  sha256Bytes,
  sha256Hex,
  splitTiles,
  verifyMerklePath,
} from "./merkle.mjs";

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, prettyJson(value), "utf8");
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeDemoPuzzlePng(path, config = DEMO_CONFIG) {
  const puzzle = generateSyntheticPuzzle(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodePngRgb(puzzle));
  return puzzle;
}

export async function writeDefaultModelBundle(path) {
  const bundle = defaultModelBundle();
  const modelHash = modelBundleHash(bundle);
  await writeJson(path, { ...bundle, model_hash: modelHash });
  return { bundle, modelHash };
}

export async function readModelBundle(path) {
  if (!path) {
    const bundle = defaultModelBundle();
    return { bundle, modelHash: modelBundleHash(bundle) };
  }

  const parsed = await readJson(path);
  const { model_hash: _modelHash, ...bundle } = parsed;
  return { bundle, modelHash: modelBundleHash(bundle) };
}

export function modelBundleHash(bundle) {
  return sha256Hex(textBytes(stableJson(bundle)));
}

export async function commitImageFile({ imagePath, outPath, imageId = DEMO_CONFIG.imageId }) {
  const png = decodePng(await readFile(imagePath));
  const commitment = commitPixels({
    imageId,
    width: png.width,
    height: png.height,
    pixels: png.pixels,
  });

  if (outPath) {
    await writeJson(outPath, commitment);
  }
  return commitment;
}

export function commitPixels({ imageId, width, height, pixels, config = DEMO_CONFIG }) {
  if (width !== config.width || height !== config.height) {
    throw new Error(`expected ${config.width}x${config.height} PNG, got ${width}x${height}`);
  }

  const { tileColumns, tileRows, tiles } = splitTiles({
    pixels,
    width,
    height,
    tileSize: config.tileSize,
  });
  const tree = buildMerkleTree(tiles.map((tile) => tile.leaf));
  const preprocessing = preprocessingSpec(config);

  return {
    schema: "zk-waldo-image-commitment-v0",
    image_id: imageId,
    image_width: width,
    image_height: height,
    crop_width: config.cropSize,
    crop_height: config.cropSize,
    tile_size: config.tileSize,
    tile_columns: tileColumns,
    tile_rows: tileRows,
    leaf_count: tiles.length,
    hash_function: HASH_FUNCTION,
    image_root: bytesToHex(tree.root),
    preprocessing_hash: sha256Hex(textBytes(stableJson(preprocessing))),
  };
}

export async function generateWitnessFile({ imagePath, commitmentPath, x, y, outPath }) {
  const commitment = await readJson(commitmentPath);
  const png = decodePng(await readFile(imagePath));
  const witness = generateWitness({
    commitment,
    width: png.width,
    height: png.height,
    pixels: png.pixels,
    x,
    y,
  });

  if (outPath) {
    await writeJson(outPath, witness);
  }
  return witness;
}

export function generateWitness({ commitment, width, height, pixels, x, y, config = DEMO_CONFIG }) {
  assertAlignedCrop({
    x,
    y,
    imageWidth: width,
    imageHeight: height,
    cropSize: config.cropSize,
    tileSize: config.tileSize,
  });

  const recomputed = commitPixels({
    imageId: commitment.image_id,
    width,
    height,
    pixels,
    config,
  });
  if (recomputed.image_root !== commitment.image_root) {
    throw new Error("image bytes do not match commitment root");
  }

  const { tileColumns, tiles } = splitTiles({
    pixels,
    width,
    height,
    tileSize: config.tileSize,
  });
  const tree = buildMerkleTree(tiles.map((tile) => tile.leaf));
  const cropPixels = extractCropFromPixels(pixels, width, height, x, y, config.cropSize);
  const startTileX = x / config.tileSize;
  const startTileY = y / config.tileSize;
  const tilesPerSide = config.cropSize / config.tileSize;
  const tileWitnesses = [];

  for (let dy = 0; dy < tilesPerSide; dy += 1) {
    for (let dx = 0; dx < tilesPerSide; dx += 1) {
      const tileX = startTileX + dx;
      const tileY = startTileY + dy;
      const leafIndex = tileY * tileColumns + tileX;
      const tile = tiles[leafIndex];
      tileWitnesses.push({
        tile_x: tileX,
        tile_y: tileY,
        leaf_index: leafIndex,
        pixels: bytesToHex(tile.pixels),
        merkle_path: getMerklePath(tree, leafIndex),
      });
    }
  }

  return {
    schema: "zk-waldo-private-witness-v0",
    x,
    y,
    crop_width: config.cropSize,
    crop_height: config.cropSize,
    crop_pixels: bytesToHex(cropPixels),
    tiles: tileWitnesses,
  };
}

export async function proveFile({
  commitmentPath,
  witnessPath,
  modelPath,
  thresholdLogit = DEMO_CONFIG.thresholdLogit,
  outPath,
}) {
  const commitment = await readJson(commitmentPath);
  const witness = await readJson(witnessPath);
  const { bundle, modelHash } = await readModelBundle(modelPath);
  const proof = prove({
    commitment,
    witness,
    modelBundle: bundle,
    modelHash,
    thresholdLogit,
  });

  if (outPath) {
    await writeJson(outPath, proof);
  }
  return proof;
}

export function prove({ commitment, witness, modelBundle, modelHash, thresholdLogit }) {
  const effectiveModelHash = modelHash ?? modelBundleHash(modelBundle);
  const cropPixels = verifyWitnessAndRecoverCrop({ commitment, witness });
  const { logit } = quantizedDetectorLogit(cropPixels, commitment.crop_width);

  if (logit < thresholdLogit) {
    throw new Error(`classifier logit ${logit} is below threshold ${thresholdLogit}`);
  }

  const publicInputs = makePublicInputs({
    commitment,
    modelHash: effectiveModelHash,
    thresholdLogit,
  });
  const publicOutput = {
    accepted: true,
    statement:
      "prover knows a private crop from image_root that passes model_hash at threshold_logit",
  };
  const transcript = {
    protocol_version: PROTOCOL_VERSION,
    backend: PROOF_BACKEND,
    public_inputs: publicInputs,
    public_output: publicOutput,
    model_id: modelBundle.model_id,
  };
  const proofDigest = sha256Hex(textBytes(stableJson(transcript)));

  return {
    schema: "zk-waldo-proof-receipt-v0",
    protocol_version: PROTOCOL_VERSION,
    backend: PROOF_BACKEND,
    cryptographic_status:
      "demo attestation only; replace this backend with EZKL/RISC Zero for production zero-knowledge soundness",
    public_inputs: publicInputs,
    public_output: publicOutput,
    proof_digest: proofDigest,
    attestation: hmacHex(proofDigest),
    verifier_notice:
      "This receipt intentionally omits coordinates, crop pixels, tile pixels, leaf indices, and Merkle paths.",
  };
}

export function verifyWitnessAndRecoverCrop({ commitment, witness }) {
  if (witness.schema !== "zk-waldo-private-witness-v0") {
    throw new Error("unsupported witness schema");
  }

  assertAlignedCrop({
    x: witness.x,
    y: witness.y,
    imageWidth: commitment.image_width,
    imageHeight: commitment.image_height,
    cropSize: commitment.crop_width,
    tileSize: commitment.tile_size,
  });

  const expectedTileCount =
    (commitment.crop_width / commitment.tile_size) * (commitment.crop_height / commitment.tile_size);
  if (witness.tiles.length !== expectedTileCount) {
    throw new Error(`expected ${expectedTileCount} tile witnesses`);
  }

  const startTileX = witness.x / commitment.tile_size;
  const startTileY = witness.y / commitment.tile_size;
  const tilesPerRow = commitment.crop_width / commitment.tile_size;
  const tileMap = new Map();

  for (const tile of witness.tiles) {
    const expectedLeafIndex = tile.tile_y * commitment.tile_columns + tile.tile_x;
    if (tile.leaf_index !== expectedLeafIndex) {
      throw new Error("tile witness leaf index does not match private coordinates");
    }

    const tilePixels = hexToBytes(tile.pixels);
    const leaf = hashTile({ tileX: tile.tile_x, tileY: tile.tile_y, pixels: tilePixels });
    const ok = verifyMerklePath({
      leaf,
      leafIndex: tile.leaf_index,
      path: tile.merkle_path,
      expectedRoot: commitment.image_root,
    });
    if (!ok) {
      throw new Error("invalid Merkle path for private tile witness");
    }

    tileMap.set(`${tile.tile_x},${tile.tile_y}`, tilePixels);
  }

  const recovered = new Uint8Array(commitment.crop_width * commitment.crop_height * 3);
  for (let dy = 0; dy < tilesPerRow; dy += 1) {
    for (let dx = 0; dx < tilesPerRow; dx += 1) {
      const tileX = startTileX + dx;
      const tileY = startTileY + dy;
      const tilePixels = tileMap.get(`${tileX},${tileY}`);
      if (!tilePixels) {
        throw new Error("missing required private tile witness");
      }

      for (let row = 0; row < commitment.tile_size; row += 1) {
        const srcStart = row * commitment.tile_size * 3;
        const srcEnd = srcStart + commitment.tile_size * 3;
        const destRow = dy * commitment.tile_size + row;
        const destColumn = dx * commitment.tile_size;
        const destStart = (destRow * commitment.crop_width + destColumn) * 3;
        recovered.set(tilePixels.subarray(srcStart, srcEnd), destStart);
      }
    }
  }

  const declaredCrop = hexToBytes(witness.crop_pixels);
  if (!constantTimeBytesEqual(recovered, declaredCrop)) {
    throw new Error("declared crop pixels do not match committed tile witnesses");
  }

  return recovered;
}

export async function verifyFile({
  proofPath,
  commitmentPath,
  modelPath,
  thresholdLogit = DEMO_CONFIG.thresholdLogit,
}) {
  const proof = await readJson(proofPath);
  const commitment = await readJson(commitmentPath);
  const { bundle, modelHash } = await readModelBundle(modelPath);
  return verifyProof({ proof, commitment, modelBundle: bundle, modelHash, thresholdLogit });
}

export function verifyProof({ proof, commitment, modelBundle, modelHash, thresholdLogit }) {
  const privacyHits = inspectProofPrivacy(proof);
  if (privacyHits.length > 0) {
    return {
      valid: false,
      reason: `proof leaks private witness fields: ${privacyHits.join(", ")}`,
    };
  }

  const effectiveModelHash = modelHash ?? modelBundleHash(modelBundle);
  const expectedPublicInputs = makePublicInputs({
    commitment,
    modelHash: effectiveModelHash,
    thresholdLogit,
  });
  if (stableJson(proof.public_inputs) !== stableJson(expectedPublicInputs)) {
    return { valid: false, reason: "public inputs do not match verifier expectations" };
  }

  const expectedOutput = {
    accepted: true,
    statement:
      "prover knows a private crop from image_root that passes model_hash at threshold_logit",
  };
  if (stableJson(proof.public_output) !== stableJson(expectedOutput)) {
    return { valid: false, reason: "public output is not the expected accepted statement" };
  }

  const transcript = {
    protocol_version: PROTOCOL_VERSION,
    backend: PROOF_BACKEND,
    public_inputs: expectedPublicInputs,
    public_output: expectedOutput,
    model_id: modelBundle.model_id,
  };
  const expectedDigest = sha256Hex(textBytes(stableJson(transcript)));
  if (proof.proof_digest !== expectedDigest) {
    return { valid: false, reason: "proof digest does not match transcript" };
  }

  const expectedAttestation = hmacHex(expectedDigest);
  if (!constantTimeStringEqual(proof.attestation, expectedAttestation)) {
    return { valid: false, reason: "demo attestation is invalid" };
  }

  return {
    valid: true,
    statement: `prover knows a private crop from image_root that passes model_hash at threshold ${thresholdLogit}`,
    location: "hidden",
    crop: "hidden",
    backend: PROOF_BACKEND,
  };
}

export function hmacHex(message) {
  return bytesToHex(createHmac("sha256", DEMO_ATTESTATION_KEY).update(message).digest());
}

function constantTimeBytesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function constantTimeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function onePixelMutationChangesRoot() {
  const puzzle = generateSyntheticPuzzle();
  const original = commitPixels(puzzle);
  const mutatedPixels = new Uint8Array(puzzle.pixels);
  mutatedPixels[0] ^= 1;
  const mutated = commitPixels({ ...puzzle, pixels: mutatedPixels });
  return original.image_root !== mutated.image_root;
}

export async function runFullDemo({ demoDir = "demo" } = {}) {
  const puzzlePath = `${demoDir}/puzzle.png`;
  const commitmentPath = `${demoDir}/commitment.json`;
  const witnessPath = `${demoDir}/witness.private.json`;
  const modelPath = "models/artifacts/model_bundle.json";
  const proofPath = `${demoDir}/proof.receipt.json`;

  await writeDemoPuzzlePng(puzzlePath);
  await writeDefaultModelBundle(modelPath);
  await commitImageFile({ imagePath: puzzlePath, outPath: commitmentPath });
  await generateWitnessFile({
    imagePath: puzzlePath,
    commitmentPath,
    x: DEMO_CONFIG.targetX,
    y: DEMO_CONFIG.targetY,
    outPath: witnessPath,
  });
  await proveFile({
    commitmentPath,
    witnessPath,
    modelPath,
    thresholdLogit: DEMO_CONFIG.thresholdLogit,
    outPath: proofPath,
  });
  const verification = await verifyFile({
    proofPath,
    commitmentPath,
    modelPath,
    thresholdLogit: DEMO_CONFIG.thresholdLogit,
  });

  return {
    puzzlePath,
    commitmentPath,
    witnessPath,
    modelPath,
    proofPath,
    verification,
  };
}
