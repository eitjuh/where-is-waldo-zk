import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEMO_CONFIG,
  defaultModelBundle,
  extractCropFromPixels,
  generateSyntheticPuzzle,
  hexToBytes,
  inspectProofPrivacy,
  quantizedDetectorLogit,
} from "../src/shared-core.mjs";
import { decodePng, encodePngRgb } from "../src/png.mjs";
import {
  commitPixels,
  generateWitness,
  modelBundleHash,
  onePixelMutationChangesRoot,
  prove,
  verifyProof,
  verifyWitnessAndRecoverCrop,
} from "../src/protocol.mjs";

function fixture() {
  const puzzle = generateSyntheticPuzzle();
  const commitment = commitPixels(puzzle);
  const modelBundle = defaultModelBundle();
  const modelHash = modelBundleHash(modelBundle);
  const witness = generateWitness({
    commitment,
    width: puzzle.width,
    height: puzzle.height,
    pixels: puzzle.pixels,
    x: DEMO_CONFIG.targetX,
    y: DEMO_CONFIG.targetY,
  });
  return { puzzle, commitment, modelBundle, modelHash, witness };
}

test("PNG encoder and decoder round-trip generated RGB pixels", () => {
  const puzzle = generateSyntheticPuzzle();
  const decoded = decodePng(encodePngRgb(puzzle));
  assert.equal(decoded.width, puzzle.width);
  assert.equal(decoded.height, puzzle.height);
  assert.deepEqual(decoded.pixels, puzzle.pixels);
});

test("image commitment is stable and changes when a pixel changes", () => {
  const puzzle = generateSyntheticPuzzle();
  assert.equal(commitPixels(puzzle).image_root, commitPixels(puzzle).image_root);
  assert.equal(onePixelMutationChangesRoot(), true);
});

test("target crop passes while a random crop fails the detector threshold", () => {
  const puzzle = generateSyntheticPuzzle();
  const positive = extractCropFromPixels(
    puzzle.pixels,
    puzzle.width,
    puzzle.height,
    DEMO_CONFIG.targetX,
    DEMO_CONFIG.targetY,
    DEMO_CONFIG.cropSize,
  );
  const negative = extractCropFromPixels(puzzle.pixels, puzzle.width, puzzle.height, 32, 32, DEMO_CONFIG.cropSize);

  assert.ok(quantizedDetectorLogit(positive).logit >= DEMO_CONFIG.thresholdLogit);
  assert.ok(quantizedDetectorLogit(negative).logit < DEMO_CONFIG.thresholdLogit);
});

test("valid witness recovers the private crop from committed tiles", () => {
  const { witness, commitment } = fixture();
  const recovered = verifyWitnessAndRecoverCrop({ commitment, witness });
  assert.deepEqual(recovered, hexToBytes(witness.crop_pixels));
});

test("tampered Merkle path fails before proof generation", () => {
  const { witness, commitment, modelBundle, modelHash } = fixture();
  const tampered = structuredClone(witness);
  tampered.tiles[0].merkle_path[0].sibling = `0x${"00".repeat(32)}`;

  assert.throws(
    () =>
      prove({
        commitment,
        witness: tampered,
        modelBundle,
        modelHash,
        thresholdLogit: DEMO_CONFIG.thresholdLogit,
      }),
    /invalid Merkle path/,
  );
});

test("declared crop mismatch fails before proof generation", () => {
  const { witness, commitment, modelBundle, modelHash } = fixture();
  const tampered = structuredClone(witness);
  tampered.crop_pixels = `0x${"ff".repeat(DEMO_CONFIG.cropSize * DEMO_CONFIG.cropSize * 3)}`;

  assert.throws(
    () =>
      prove({
        commitment,
        witness: tampered,
        modelBundle,
        modelHash,
        thresholdLogit: DEMO_CONFIG.thresholdLogit,
      }),
    /declared crop pixels/,
  );
});

test("wrong crop fails classifier threshold during proof generation", () => {
  const puzzle = generateSyntheticPuzzle();
  const commitment = commitPixels(puzzle);
  const modelBundle = defaultModelBundle();
  const modelHash = modelBundleHash(modelBundle);
  const witness = generateWitness({
    commitment,
    width: puzzle.width,
    height: puzzle.height,
    pixels: puzzle.pixels,
    x: 32,
    y: 32,
  });

  assert.throws(
    () =>
      prove({
        commitment,
        witness,
        modelBundle,
        modelHash,
        thresholdLogit: DEMO_CONFIG.thresholdLogit,
      }),
    /below threshold/,
  );
});

test("valid proof verifies and leaks no private witness fields", () => {
  const { witness, commitment, modelBundle, modelHash } = fixture();
  const proof = prove({
    commitment,
    witness,
    modelBundle,
    modelHash,
    thresholdLogit: DEMO_CONFIG.thresholdLogit,
  });

  assert.deepEqual(inspectProofPrivacy(proof), []);
  const result = verifyProof({
    proof,
    commitment,
    modelBundle,
    modelHash,
    thresholdLogit: DEMO_CONFIG.thresholdLogit,
  });
  assert.equal(result.valid, true);
});

test("verification rejects wrong root, wrong model, and threshold manipulation", () => {
  const { puzzle, witness, commitment, modelBundle, modelHash } = fixture();
  const proof = prove({
    commitment,
    witness,
    modelBundle,
    modelHash,
    thresholdLogit: DEMO_CONFIG.thresholdLogit,
  });

  const mutatedPixels = new Uint8Array(puzzle.pixels);
  mutatedPixels[0] ^= 1;
  const wrongCommitment = commitPixels({ ...puzzle, pixels: mutatedPixels });
  assert.equal(
    verifyProof({
      proof,
      commitment: wrongCommitment,
      modelBundle,
      modelHash,
      thresholdLogit: DEMO_CONFIG.thresholdLogit,
    }).valid,
    false,
  );

  const wrongModel = { ...modelBundle, weights: { ...modelBundle.weights, bias: -1249 } };
  assert.equal(
    verifyProof({
      proof,
      commitment,
      modelBundle: wrongModel,
      modelHash: modelBundleHash(wrongModel),
      thresholdLogit: DEMO_CONFIG.thresholdLogit,
    }).valid,
    false,
  );

  assert.equal(
    verifyProof({
      proof,
      commitment,
      modelBundle,
      modelHash,
      thresholdLogit: DEMO_CONFIG.thresholdLogit - 1,
    }).valid,
    false,
  );
});
