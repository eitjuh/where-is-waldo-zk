#!/usr/bin/env node
import {
  DEMO_CONFIG,
  generateSyntheticPuzzle,
  quantizedDetectorLogit,
} from "./shared-core.mjs";
import {
  commitImageFile,
  generateWitnessFile,
  proveFile,
  readJson,
  runFullDemo,
  verifyFile,
  writeDefaultModelBundle,
  writeDemoPuzzlePng,
} from "./protocol.mjs";

const command = process.argv[2] ?? "help";
const args = parseArgs(process.argv.slice(3));

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "init-demo") {
    const puzzlePath = args.image ?? "demo/puzzle.png";
    const modelPath = args.model ?? "models/artifacts/model_bundle.json";
    await writeDemoPuzzlePng(puzzlePath);
    const { modelHash } = await writeDefaultModelBundle(modelPath);
    const crop = generateSyntheticPuzzle().pixels;
    console.log(`Wrote ${puzzlePath}`);
    console.log(`Wrote ${modelPath}`);
    console.log(`model_hash: ${modelHash}`);
    console.log(`target demo coordinates: x=${DEMO_CONFIG.targetX}, y=${DEMO_CONFIG.targetY}`);
    console.log(`detector threshold: ${DEMO_CONFIG.thresholdLogit}`);
    void crop;
  } else if (command === "commit-image") {
    const imagePath = required(args.image, "--image");
    const outPath = required(args.out, "--out");
    const commitment = await commitImageFile({ imagePath, outPath });
    console.log(`image_root: ${commitment.image_root}`);
    console.log(`preprocessing_hash: ${commitment.preprocessing_hash}`);
    console.log(`Wrote ${outPath}`);
  } else if (command === "generate-witness") {
    const imagePath = required(args.image, "--image");
    const commitmentPath = required(args.commitment, "--commitment");
    const outPath = required(args.out, "--out");
    const x = Number.parseInt(required(args.x, "--x"), 10);
    const y = Number.parseInt(required(args.y, "--y"), 10);
    await generateWitnessFile({ imagePath, commitmentPath, x, y, outPath });
    console.log(`Wrote private witness ${outPath}`);
    console.log("Keep this file private; it contains x, y, crop pixels, tile pixels, and Merkle paths.");
  } else if (command === "prove") {
    const commitmentPath = required(args.commitment, "--commitment");
    const witnessPath = required(args.witness, "--witness");
    const outPath = required(args.out, "--out");
    const modelPath = args.model ?? "models/artifacts/model_bundle.json";
    const thresholdLogit = Number.parseInt(args.threshold ?? `${DEMO_CONFIG.thresholdLogit}`, 10);
    const proof = await proveFile({ commitmentPath, witnessPath, modelPath, thresholdLogit, outPath });
    console.log(`Proof generated: ${outPath}`);
    console.log(`proof_digest: ${proof.proof_digest}`);
    console.log("Location: hidden.");
    console.log("Crop: hidden.");
  } else if (command === "verify") {
    const proofPath = required(args.proof, "--proof");
    const commitmentPath = required(args.commitment, "--commitment");
    const modelPath = args.model ?? "models/artifacts/model_bundle.json";
    const thresholdLogit = Number.parseInt(args.threshold ?? `${DEMO_CONFIG.thresholdLogit}`, 10);
    const result = await verifyFile({ proofPath, commitmentPath, modelPath, thresholdLogit });
    printVerification(result);
    process.exitCode = result.valid ? 0 : 1;
  } else if (command === "score-witness") {
    const witness = await readJson(required(args.witness, "--witness"));
    const { hexToBytes } = await import("./shared-core.mjs");
    const result = quantizedDetectorLogit(hexToBytes(witness.crop_pixels), witness.crop_width);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "demo") {
    const result = await runFullDemo({ demoDir: args.dir ?? "demo" });
    printVerification(result.verification);
    console.log("");
    console.log("Artifacts:");
    console.log(`  puzzle:     ${result.puzzlePath}`);
    console.log(`  commitment: ${result.commitmentPath}`);
    console.log(`  witness:    ${result.witnessPath} (private)`);
    console.log(`  model:      ${result.modelPath}`);
    console.log(`  proof:      ${result.proofPath}`);
    console.log("");
    console.log("Run the web demo with: pnpm serve");
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected positional argument ${token}`);
    }
    const key = token.slice(2).replaceAll("-", "_");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function required(value, flag) {
  if (value === undefined || value === "") {
    throw new Error(`missing required ${flag}`);
  }
  return value;
}

function printVerification(result) {
  if (result.valid) {
    console.log("Proof valid.");
    console.log(`Statement: ${result.statement}.`);
    console.log("Location: hidden.");
    console.log("Crop: hidden.");
    console.log(`Backend: ${result.backend}.`);
  } else {
    console.log("Proof invalid.");
    console.log(`Reason: ${result.reason}`);
  }
}

function printHelp() {
  console.log(`zk-waldo

Usage:
  pnpm zk-waldo init-demo
  pnpm zk-waldo commit-image --image demo/puzzle.png --out demo/commitment.json
  pnpm zk-waldo generate-witness --image demo/puzzle.png --commitment demo/commitment.json --x 224 --y 160 --out demo/witness.private.json
  pnpm zk-waldo prove --commitment demo/commitment.json --witness demo/witness.private.json --out demo/proof.receipt.json
  pnpm zk-waldo verify --commitment demo/commitment.json --proof demo/proof.receipt.json
  pnpm demo
`);
}
