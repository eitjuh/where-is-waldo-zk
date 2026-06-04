import {
  DEMO_ATTESTATION_KEY,
  DEMO_CONFIG,
  HASH_FUNCTION,
  PROOF_BACKEND,
  PROTOCOL_VERSION,
  bytesToHex,
  concatBytes,
  defaultModelBundle,
  extractCropFromPixels,
  generateSyntheticPuzzle,
  hexToBytes,
  inspectProofPrivacy,
  makePublicInputs,
  pixelBytesToRgba,
  preprocessingSpec,
  quantizedDetectorLogit,
  stableJson,
  textBytes,
  u32be,
} from "../../src/shared-core.mjs";

const canvas = document.querySelector("#puzzleCanvas");
const rootField = document.querySelector("#rootField");
const modelField = document.querySelector("#modelField");
const proofField = document.querySelector("#proofField");
const resultPanel = document.querySelector("#resultPanel");
const statusStrip = document.querySelector("#statusStrip");
const proveButton = document.querySelector("#proveButton");
const verifyButton = document.querySelector("#verifyButton");
const resetButton = document.querySelector("#resetButton");

let state;

resetButton.addEventListener("click", () => void init());
proveButton.addEventListener("click", () => void generateProof());
verifyButton.addEventListener("click", () => void verifyCurrentProof());

await init();

async function init() {
  setStatus("Committing public puzzle image...");
  const puzzle = generateSyntheticPuzzle();
  drawPuzzle(puzzle);
  const modelBundle = defaultModelBundle();
  const modelHash = await sha256Hex(textBytes(stableJson(modelBundle)));
  const commitment = await commitPuzzle(puzzle);
  state = { puzzle, commitment, modelBundle, modelHash };
  rootField.value = commitment.image_root;
  modelField.value = modelHash;
  proofField.value = "";
  setResult("No proof verified yet.", "The verifier output will appear here.", "");
  setStatus("Ready. The public image is committed; the target location remains private.");
}

async function generateProof() {
  setStatus("Generating a private witness and local demo proof...");
  const cropPixels = extractCropFromPixels(
    state.puzzle.pixels,
    state.puzzle.width,
    state.puzzle.height,
    DEMO_CONFIG.targetX,
    DEMO_CONFIG.targetY,
    DEMO_CONFIG.cropSize,
  );
  const { logit } = quantizedDetectorLogit(cropPixels);
  if (logit < DEMO_CONFIG.thresholdLogit) {
    throw new Error("demo target crop unexpectedly failed the detector");
  }

  const publicInputs = makePublicInputs({
    commitment: state.commitment,
    modelHash: state.modelHash,
    thresholdLogit: DEMO_CONFIG.thresholdLogit,
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
    model_id: state.modelBundle.model_id,
  };
  const proofDigest = await sha256Hex(textBytes(stableJson(transcript)));
  const proof = {
    schema: "zk-waldo-proof-receipt-v0",
    protocol_version: PROTOCOL_VERSION,
    backend: PROOF_BACKEND,
    cryptographic_status:
      "browser demo attestation only; run pnpm zkvm:prove for the RISC Zero receipt backend",
    public_inputs: publicInputs,
    public_output: publicOutput,
    proof_digest: proofDigest,
    attestation: await hmacHex(proofDigest),
    verifier_notice:
      "This receipt intentionally omits coordinates, crop pixels, tile pixels, leaf indices, and Merkle paths.",
  };

  proofField.value = JSON.stringify(proof, null, 2);
  setStatus("Proof receipt generated. The text area contains public data only.");
}

async function verifyCurrentProof() {
  try {
    const proof = JSON.parse(proofField.value);
    const result = await verifyProof(proof);
    if (result.valid) {
      setResult("Proof valid.", result.statement, "valid");
      setStatus("Verified from public inputs only: image_root, model_hash, threshold, and receipt.");
    } else {
      setResult("Proof invalid.", result.reason, "invalid");
      setStatus("Verification failed.");
    }
  } catch (error) {
    setResult("Proof invalid.", error.message, "invalid");
    setStatus("Verification failed.");
  }
}

async function verifyProof(proof) {
  const privacyHits = inspectProofPrivacy(proof);
  if (privacyHits.length > 0) {
    return { valid: false, reason: `proof leaks private fields: ${privacyHits.join(", ")}` };
  }

  const expectedPublicInputs = makePublicInputs({
    commitment: state.commitment,
    modelHash: state.modelHash,
    thresholdLogit: DEMO_CONFIG.thresholdLogit,
  });
  if (stableJson(proof.public_inputs) !== stableJson(expectedPublicInputs)) {
    return { valid: false, reason: "public inputs do not match this puzzle/model/threshold" };
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
    model_id: state.modelBundle.model_id,
  };
  const expectedDigest = await sha256Hex(textBytes(stableJson(transcript)));
  if (proof.proof_digest !== expectedDigest) {
    return { valid: false, reason: "proof digest does not match transcript" };
  }

  const expectedAttestation = await hmacHex(expectedDigest);
  if (proof.attestation !== expectedAttestation) {
    return { valid: false, reason: "demo attestation is invalid" };
  }

  return {
    valid: true,
    statement:
      "prover knows a private crop from image_root that passes model_hash at threshold 700. Location and crop remain hidden.",
  };
}

async function commitPuzzle(puzzle) {
  const tileColumns = puzzle.width / DEMO_CONFIG.tileSize;
  const tileRows = puzzle.height / DEMO_CONFIG.tileSize;
  const leaves = [];
  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      const tilePixels = tileBytes(puzzle.pixels, puzzle.width, tileX, tileY);
      leaves.push(await hashTile(tileX, tileY, tilePixels));
    }
  }
  const root = await merkleRoot(leaves);
  return {
    schema: "zk-waldo-image-commitment-v0",
    image_id: DEMO_CONFIG.imageId,
    image_width: puzzle.width,
    image_height: puzzle.height,
    crop_width: DEMO_CONFIG.cropSize,
    crop_height: DEMO_CONFIG.cropSize,
    tile_size: DEMO_CONFIG.tileSize,
    tile_columns: tileColumns,
    tile_rows: tileRows,
    leaf_count: leaves.length,
    hash_function: HASH_FUNCTION,
    image_root: bytesToHex(root),
    preprocessing_hash: await sha256Hex(textBytes(stableJson(preprocessingSpec()))),
  };
}

function tileBytes(pixels, imageWidth, tileX, tileY) {
  const tileSize = DEMO_CONFIG.tileSize;
  const tile = new Uint8Array(tileSize * tileSize * 3);
  for (let row = 0; row < tileSize; row += 1) {
    const srcStart = ((tileY * tileSize + row) * imageWidth + tileX * tileSize) * 3;
    tile.set(pixels.subarray(srcStart, srcStart + tileSize * 3), row * tileSize * 3);
  }
  return tile;
}

async function hashTile(tileX, tileY, pixels) {
  return sha256Bytes(concatBytes([textBytes("zk-waldo.tile.v0:"), u32be(tileX), u32be(tileY), pixels]));
}

async function merkleRoot(leaves) {
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(await sha256Bytes(concatBytes([textBytes("zk-waldo.merkle.node.v0:"), left, right])));
    }
    level = next;
  }
  return level[0];
}

async function sha256Bytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function sha256Hex(bytes) {
  return bytesToHex(await sha256Bytes(bytes));
}

async function hmacHex(message) {
  const key = await crypto.subtle.importKey(
    "raw",
    textBytes(DEMO_ATTESTATION_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textBytes(message));
  return bytesToHex(new Uint8Array(signature));
}

function drawPuzzle(puzzle) {
  const context = canvas.getContext("2d");
  const imageData = new ImageData(pixelBytesToRgba(puzzle.pixels), puzzle.width, puzzle.height);
  context.putImageData(imageData, 0, 0);
}

function setStatus(message) {
  statusStrip.textContent = message;
}

function setResult(title, detail, stateName) {
  resultPanel.classList.remove("valid", "invalid");
  if (stateName) {
    resultPanel.classList.add(stateName);
  }
  resultPanel.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
