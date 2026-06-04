import { buildWitnessFromClick } from "./witness-client.bundle.js";

const puzzleImage = document.querySelector("#puzzleImage");
const selection = document.querySelector("#selection");
const proofProgress = document.querySelector("#proofProgress");
const proverStatus = document.querySelector("#proverStatus");
const verifierStatus = document.querySelector("#verifierStatus");
const puzzleSelect = document.querySelector("#puzzleSelect");
const puzzleCount = document.querySelector("#puzzleCount");
const generatedProof = document.querySelector("#generatedProof");
const submittedProof = document.querySelector("#submittedProof");
const copyProofButton = document.querySelector("#copyProofButton");
const downloadProofButton = document.querySelector("#downloadProofButton");
const sendProofButton = document.querySelector("#sendProofButton");
const verifyButton = document.querySelector("#verifyButton");
const proofUpload = document.querySelector("#proofUpload");
const verificationResult = document.querySelector("#verificationResult");
const verifiedPuzzle = document.querySelector("#verifiedPuzzle");

let config;
let currentPuzzle;
let proofInFlight = false;
let selectedTile;

await initialize();

async function initialize() {
  config = await requestJson("/api/real/config");
  for (const puzzle of config.puzzles) {
    const option = document.createElement("option");
    option.value = puzzle.id;
    option.textContent = puzzle.title;
    puzzleSelect.append(option);
  }
  puzzleCount.textContent = `${config.puzzles.length} pages`;
  puzzleSelect.value = config.default_puzzle_id;
  await selectPuzzle(config.default_puzzle_id);
  document.querySelector("#modelBadge").textContent =
    `${config.model_id} · ${(config.metrics.balanced_accuracy * 100).toFixed(1)}% balanced accuracy`;
  document.querySelector("#modelHash").textContent = config.model_hash;
  document.querySelector("#threshold").textContent = String(config.threshold_logit);
  const proveHint = document.querySelector("#proveHint");
  if (config.server_prove_hint) {
    proveHint.textContent = config.server_prove_hint;
    proveHint.hidden = false;
  } else {
    proveHint.hidden = true;
  }
  setStatus(proverStatus, "Ready · select Waldo (witness stays local until prove)", "idle");
}

puzzleImage.addEventListener("click", (event) => void handlePuzzleClick(event));
copyProofButton.addEventListener("click", () => void copyGeneratedProof());
downloadProofButton.addEventListener("click", downloadGeneratedProof);
sendProofButton.addEventListener("click", sendGeneratedProof);
verifyButton.addEventListener("click", () => void verifySubmittedProof());
proofUpload.addEventListener("change", () => void loadUploadedProof());
puzzleSelect.addEventListener("change", () => void selectPuzzle(puzzleSelect.value));
puzzleImage.addEventListener("error", () => {
  setStatus(
    proverStatus,
    "Puzzle image not found — restart the demo server after catalog or asset changes",
    "bad",
  );
});
puzzleImage.addEventListener("load", refreshSelection);
window.addEventListener("resize", refreshSelection);

async function selectPuzzle(puzzleId) {
  currentPuzzle = config.puzzles.find((puzzle) => puzzle.id === puzzleId);
  if (!currentPuzzle) {
    return;
  }
  puzzleImage.src = currentPuzzle.image_url;
  await imageReady(puzzleImage);
  document.querySelector("#rootBadge").textContent = currentPuzzle.image_root;
  if (verifiedPuzzle.textContent === "—") {
    document.querySelector("#imageRoot").textContent = currentPuzzle.image_root;
  }
  selection.hidden = true;
  selectedTile = undefined;
  generatedProof.value = "";
  setProofActions(false);
  setStatus(proverStatus, `Ready · ${currentPuzzle.title}`, "idle");
}

async function handlePuzzleClick(event) {
  if (proofInFlight) {
    return;
  }
  const rect = puzzleImage.getBoundingClientRect();
  const imageX = Math.floor(((event.clientX - rect.left) / rect.width) * config.dimensions.image[0]);
  const imageY = Math.floor(((event.clientY - rect.top) / rect.height) * config.dimensions.image[1]);
  const tileSize = config.dimensions.tile_size;
  const x = Math.floor(imageX / tileSize) * tileSize;
  const y = Math.floor(imageY / tileSize) * tileSize;
  showSelection(x, y);
  await generateProof(x, y);
}

async function generateProof(x, y) {
  proofInFlight = true;
  puzzleSelect.disabled = true;
  proofProgress.hidden = false;
  generatedProof.value = "";
  setProofActions(false);
  setStatus(proverStatus, "Building private witness in browser", "busy");
  try {
    const witness = await buildWitnessFromClick({
      imageUrl: currentPuzzle.image_url,
      commitment: currentPuzzle.commitment,
      x,
      y,
    });
    const body = JSON.stringify({ puzzle_id: currentPuzzle.id, witness });
    let result;
    let provedLocally = false;
    if (config.prefer_local_prover !== false) {
      try {
        setStatus(proverStatus, "Running local RISC Zero prover on loopback", "busy");
        result = await requestJson(config.local_prover_url, {
          method: "POST",
          body,
        });
        provedLocally = true;
      } catch (localError) {
        if (config.require_local_prover) {
          throw new Error(
            `${localError.message} Start the local prover with: pnpm real:prove:daemon`,
          );
        }
      }
    }
    if (!result) {
      setStatus(proverStatus, "Generating proof on server…", "busy");
      const started = await requestJson("/api/real/prove", {
        method: "POST",
        body,
      });
      result = await pollProveJob(started);
    }
    generatedProof.value = JSON.stringify(result.proof, null, 2);
    setProofActions(true);
    setStatus(
      proverStatus,
      `${result.puzzle.title} proof · ${(result.prover.prove_ms / 1000).toFixed(1)}s${provedLocally ? " · local" : ""}`,
      "ok",
    );
  } catch (error) {
    const rejected = error.code === "CNN_REJECTED";
    setStatus(
      proverStatus,
      rejected ? "That tile did not pass the trained CNN" : error.message,
      "bad",
    );
  } finally {
    proofProgress.hidden = true;
    proofInFlight = false;
    puzzleSelect.disabled = false;
  }
}

function imageReady(image) {
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

function showSelection(x, y) {
  selectedTile = { x, y };
  refreshSelection();
}

function refreshSelection() {
  if (!selectedTile || !puzzleImage.clientWidth) {
    return;
  }
  const [imageWidth] = config.dimensions.image;
  const tileSize = config.dimensions.tile_size;
  const scale = puzzleImage.clientWidth / imageWidth;
  selection.hidden = false;
  selection.style.left = `${selectedTile.x * scale}px`;
  selection.style.top = `${selectedTile.y * scale}px`;
  selection.style.width = `${tileSize * scale}px`;
  selection.style.height = `${tileSize * scale}px`;
}

async function copyGeneratedProof() {
  try {
    await navigator.clipboard.writeText(generatedProof.value);
  } catch {
    generatedProof.focus();
    generatedProof.select();
    if (!document.execCommand("copy")) {
      setStatus(proverStatus, "Copy permission denied", "bad");
      return;
    }
    generatedProof.setSelectionRange(0, 0);
  }
  setStatus(proverStatus, "Proof copied", "ok");
}

function downloadGeneratedProof() {
  const blob = new Blob([generatedProof.value], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "zk-waldo-real-proof.risc0.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sendGeneratedProof() {
  submittedProof.value = generatedProof.value;
  setStatus(verifierStatus, "Proof received", "idle");
}

async function loadUploadedProof() {
  const [file] = proofUpload.files;
  if (!file) {
    return;
  }
  submittedProof.value = await file.text();
  setStatus(verifierStatus, "Proof uploaded", "idle");
}

async function verifySubmittedProof() {
  setStatus(verifierStatus, "Verifying RISC Zero receipt", "busy");
  verifyButton.disabled = true;
  try {
    const proof = JSON.parse(submittedProof.value);
    const result = await requestJson("/api/real/verify", {
      method: "POST",
      body: JSON.stringify({ proof }),
    });
    setStatus(verifierStatus, "Receipt verified", "ok");
    verifiedPuzzle.textContent = result.puzzle.title;
    document.querySelector("#imageRoot").textContent = result.puzzle.image_root;
    setResult(true, "Proof valid", `${result.statement} Puzzle: ${result.puzzle.title}.`);
  } catch (error) {
    setStatus(verifierStatus, "Verification failed", "bad");
    verifiedPuzzle.textContent = "—";
    document.querySelector("#imageRoot").textContent = currentPuzzle.image_root;
    setResult(false, "Proof invalid", error.message);
  } finally {
    verifyButton.disabled = false;
  }
}

function setProofActions(enabled) {
  copyProofButton.disabled = !enabled;
  downloadProofButton.disabled = !enabled;
  sendProofButton.disabled = !enabled;
}

function setStatus(element, message, state) {
  element.textContent = message;
  element.dataset.state = state;
}

function setResult(valid, title, message) {
  verificationResult.dataset.state = valid ? "ok" : "bad";
  verificationResult.querySelector(".result-mark").textContent = valid ? "✓" : "×";
  verificationResult.querySelector("strong").textContent = title;
  verificationResult.querySelector("p").textContent = message;
}

async function pollProveJob(started) {
  const pollUrl = started.poll_url ?? `/api/real/prove/jobs/${started.job_id}`;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await requestJson(pollUrl);
    if (status.status === "done") {
      return status.result;
    }
    if (status.status === "failed") {
      const error = new Error(status.error ?? status.message ?? "Proof failed");
      error.code = status.code;
      throw error;
    }
    const seconds = Math.round((status.elapsed_ms ?? 0) / 1000);
    setStatus(proverStatus, `Generating RISC Zero proof… ${seconds}s`, "busy");
    await sleep(2000);
  }
  throw new Error("Proof generation timed out. Try again or use the local prover.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error ?? `Request failed with status ${response.status}`);
    error.code = value.code;
    throw error;
  }
  return value;
}
