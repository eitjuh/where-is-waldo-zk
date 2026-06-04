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
  selectPuzzle(config.default_puzzle_id);
  document.querySelector("#modelBadge").textContent =
    `${config.model_id} · ${(config.metrics.balanced_accuracy * 100).toFixed(1)}% balanced accuracy`;
  document.querySelector("#modelHash").textContent = config.model_hash;
  document.querySelector("#threshold").textContent = String(config.threshold_logit);
  setStatus(proverStatus, "Ready · select Waldo", "idle");
}

puzzleImage.addEventListener("click", (event) => void handlePuzzleClick(event));
copyProofButton.addEventListener("click", () => void copyGeneratedProof());
downloadProofButton.addEventListener("click", downloadGeneratedProof);
sendProofButton.addEventListener("click", sendGeneratedProof);
verifyButton.addEventListener("click", () => void verifySubmittedProof());
proofUpload.addEventListener("change", () => void loadUploadedProof());
puzzleSelect.addEventListener("change", () => selectPuzzle(puzzleSelect.value));
puzzleImage.addEventListener("load", refreshSelection);
window.addEventListener("resize", refreshSelection);

function selectPuzzle(puzzleId) {
  currentPuzzle = config.puzzles.find((puzzle) => puzzle.id === puzzleId);
  if (!currentPuzzle) {
    return;
  }
  puzzleImage.src = currentPuzzle.image_url;
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
  setStatus(proverStatus, "Running private CNN and prover", "busy");
  try {
    const result = await requestJson("/api/real/prove", {
      method: "POST",
      body: JSON.stringify({ puzzle_id: currentPuzzle.id, x, y }),
    });
    generatedProof.value = JSON.stringify(result.proof, null, 2);
    setProofActions(true);
    setStatus(
      proverStatus,
      `${result.puzzle.title} proof · ${(result.prover.prove_ms / 1000).toFixed(1)}s`,
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
