#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRealModel } from "../src/real-demo.mjs";
import { findRegistryModel, loadSignedModelRegistry } from "../src/model-registry.mjs";

function parseRustBytes32(name, source) {
  const match = source.match(new RegExp(`pub const ${name}: \\[u8; 32\\] = \\[([\\s\\S]*?)\\];`));
  if (!match) {
    throw new Error(`missing ${name} in cnn_weights.rs`);
  }
  const bytes = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number.parseInt(part.replace("0x", ""), 16));
  if (bytes.length !== 32) {
    throw new Error(`${name} is not 32 bytes`);
  }
  return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseRustI32(name, source) {
  const match = source.match(new RegExp(`pub const ${name}: i32 = (-?\\d+);`));
  if (!match) {
    throw new Error(`missing ${name} in cnn_weights.rs`);
  }
  return Number.parseInt(match[1], 10);
}

const rust = await readFile(resolve("packages/zkvm/core/src/cnn_weights.rs"), "utf8");
const model = await loadRealModel();
const registry = await loadSignedModelRegistry();
const entry = findRegistryModel(registry, model.model_id);

const checks = [
  ["model_hash", parseRustBytes32("REAL_CNN_MODEL_HASH", rust), model.model_hash],
  [
    "preprocessing_hash",
    parseRustBytes32("REAL_CNN_PREPROCESSING_HASH", rust),
    model.preprocessing_hash,
  ],
  ["threshold_logit", parseRustI32("REAL_CNN_THRESHOLD", rust), model.threshold_logit],
  ["registry.model_hash", entry.model_hash, model.model_hash],
  ["registry.preprocessing_hash", entry.preprocessing_hash, model.preprocessing_hash],
  ["registry.threshold_logit", entry.threshold_logit, model.threshold_logit],
];

const failures = checks.filter(([, left, right]) => left !== right);
if (failures.length > 0) {
  for (const [label, left, right] of failures) {
    console.error(`${label}: rust/registry=${left} model=${right}`);
  }
  process.exit(1);
}

console.log("guest bindings audit: ok");
