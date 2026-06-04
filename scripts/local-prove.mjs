#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  loadPrivateRealCatalog,
  loadRealModel,
  loadRealPuzzle,
  realPuzzleConfig,
  REAL_CONFIG,
  validateRealProofPrivacy,
} from "../src/real-demo.mjs";
import { realCnnLogit } from "../src/quantized-cnn.mjs";
import { hexToBytes, prettyJson } from "../src/shared-core.mjs";
import { generateRealWitness } from "../src/witness-core.mjs";

const [, , puzzleId, xArg, yArg, receiptArg] = process.argv;
if (!puzzleId || xArg === undefined || yArg === undefined) {
  console.error("usage: node scripts/local-prove.mjs <puzzle-id> <x> <y> [receipt.json]");
  process.exit(1);
}

const x = Number(xArg);
const y = Number(yArg);
const receiptPath = resolve(receiptArg ?? REAL_CONFIG.proofPath);
const catalog = await loadPrivateRealCatalog();
const entry = catalog.puzzles.find((puzzle) => puzzle.id === puzzleId);
if (!entry) {
  throw new Error(`unknown puzzle: ${puzzleId}`);
}
const config = realPuzzleConfig(entry);
const [model, puzzle, commitment] = await Promise.all([
  loadRealModel(),
  loadRealPuzzle(config.imagePath),
  readFile(config.commitmentPath, "utf8").then((value) => JSON.parse(value)),
]);
const witness = generateRealWitness({ pixels: puzzle.pixels, commitment, x, y });
const logit = realCnnLogit(hexToBytes(witness.crop_pixels), model);
if (logit < model.threshold_logit) {
  throw new Error("selected tile does not pass the trained CNN");
}

const session = join(resolve("demo/real/runtime"), `local-${Date.now()}`);
await mkdir(session, { recursive: true });
const witnessPath = join(session, "witness.private.json");
await writeFile(witnessPath, prettyJson(witness), "utf8");

const output = await runHost([
  "run",
  "-p",
  "zk-waldo-zkvm-host",
  "--",
  "prove-real",
  "--commitment",
  config.commitmentPath,
  "--witness",
  witnessPath,
  "--receipt",
  receiptPath,
]);

const proof = JSON.parse(await readFile(receiptPath, "utf8"));
validateRealProofPrivacy(proof);
console.log(output.trim());
console.log(`wrote ${receiptPath}`);
await rm(session, { recursive: true, force: true });

function runHost(args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("cargo", args, {
      cwd: resolve("."),
      env: { ...process.env, RISC0_PROVER: "ipc" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand(stdout);
      } else {
        rejectCommand(new Error((stderr || stdout).trim() || `host exited with code ${code}`));
      }
    });
  });
}
