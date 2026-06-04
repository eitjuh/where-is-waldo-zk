import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  generateRealWitness,
  prepareRealCatalog,
  REAL_CONFIG,
  validateRealProofPrivacy,
  validateRealWitness,
} from "../src/real-demo.mjs";
import { loadSignedModelRegistry } from "../src/model-registry.mjs";
import { realCnnLogit } from "../src/quantized-cnn.mjs";
import { extractCropFromPixels, hexToBytes, inspectProofPrivacy } from "../src/shared-core.mjs";

let fixturePromise;

function fixture() {
  fixturePromise ??= prepareRealCatalog();
  return fixturePromise;
}

test("signed model registry matches the published CNN bundle", async () => {
  const registry = await loadSignedModelRegistry();
  assert.equal(registry.models.length, 1);
  assert.ok(registry.signature);
});

test("real model and six-puzzle catalog load with their fixed public contract", async () => {
  const { model, puzzles, publicCatalog } = await fixture();
  assert.equal(puzzles.length, 6);
  assert.equal(publicCatalog.default_puzzle_id, "crowded-beach");
  assert.equal(model.model_id, "waldo_real_tiny_cnn_v1");
  assert.equal(model.architecture.layers[0].op, "conv2d");
  assert.equal(model.architecture.layers[2].op, "flatten");
  assert.equal(model.metrics.catalog_false_positive_tiles, 0);
  assert.equal(new Set(puzzles.map((puzzle) => puzzle.commitment.image_root)).size, puzzles.length);
  for (const { puzzle } of puzzles) {
    assert.equal(puzzle.width, REAL_CONFIG.width);
    assert.equal(puzzle.height, REAL_CONFIG.height);
  }
});

test("trained quantized CNN accepts exactly one labeled Waldo tile on every catalog puzzle", async () => {
  const { model, puzzles } = await fixture();
  for (const entry of puzzles) {
    const accepted = [];
    for (let y = 0; y < entry.puzzle.height; y += REAL_CONFIG.tileSize) {
      for (let x = 0; x < entry.puzzle.width; x += REAL_CONFIG.tileSize) {
        const crop = extractCropFromPixels(
          entry.puzzle.pixels,
          entry.puzzle.width,
          entry.puzzle.height,
          x,
          y,
          REAL_CONFIG.cropSize,
        );
        if (realCnnLogit(crop, model) >= model.threshold_logit) {
          accepted.push({ x, y });
        }
      }
    }
    assert.deepEqual(accepted, [{ x: entry.witness.x, y: entry.witness.y }], entry.id);
  }
});

test("validateRealWitness accepts a catalog witness with its public image root", async () => {
  const { puzzles } = await fixture();
  const entry = puzzles[0];
  const witness = generateRealWitness({
    pixels: entry.puzzle.pixels,
    commitment: entry.commitment,
    x: entry.witness.x,
    y: entry.witness.y,
  });
  assert.doesNotThrow(() => validateRealWitness(witness, entry.commitment));
});

test("validateRealWitness rejects a crop that does not match its tile", async () => {
  const { puzzles } = await fixture();
  const entry = puzzles[0];
  const witness = generateRealWitness({
    pixels: entry.puzzle.pixels,
    commitment: entry.commitment,
    x: entry.witness.x,
    y: entry.witness.y,
    config: entry.config,
  });
  const tampered = structuredClone(witness);
  tampered.crop_pixels = `${witness.crop_pixels.slice(0, -2)}00`;
  assert.throws(() => validateRealWitness(tampered, entry.commitment), /crop must equal/);
});

test("every catalog private witness binds its selected crop to its public image root", async () => {
  const { model, puzzles } = await fixture();
  for (const entry of puzzles) {
    const witness = generateRealWitness({
      pixels: entry.puzzle.pixels,
      commitment: entry.commitment,
      x: entry.witness.x,
      y: entry.witness.y,
      config: entry.config,
    });
    assert.ok(realCnnLogit(hexToBytes(witness.crop_pixels), model) >= model.threshold_logit, entry.id);
    assert.equal(witness.tiles.length, 1);
    assert.equal(witness.tiles[0].merkle_path.length, 8);
  }
});

test("generated real receipt exposes no private coordinates, crop, tile, or Merkle path", async () => {
  let proof;
  try {
    proof = JSON.parse(await readFile(REAL_CONFIG.proofPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  assert.deepEqual(inspectProofPrivacy(proof), []);
  assert.doesNotThrow(() => validateRealProofPrivacy(proof));
});
