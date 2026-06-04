import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateRealProofPrivacy } from "./real-demo.mjs";
import { runZkvmHost } from "./zkvm-host-runner.mjs";
import { realCnnLogit } from "./quantized-cnn.mjs";
import { hexToBytes, prettyJson } from "./shared-core.mjs";
import { validateRealWitness } from "./witness-core.mjs";

const root = resolve(".");

export async function proveRealWitness({
  witness,
  context,
  runtimeRoot = resolve("demo/real/runtime"),
}) {
  validateRealWitness(witness, context.commitment);
  const logit = realCnnLogit(hexToBytes(witness.crop_pixels), context.model);
  if (logit < context.model.threshold_logit) {
    const error = new Error("The trained CNN rejected that private tile.");
    error.code = "CNN_REJECTED";
    throw error;
  }

  const session = await makeSession(runtimeRoot, "prove");
  try {
    const witnessPath = join(session, "witness.private.json");
    const receiptPath = join(session, "proof.risc0.json");
    await writeFile(witnessPath, prettyJson(witness), "utf8");
    const output = await runZkvmHost([
      "prove-real",
      "--commitment",
      context.config.commitmentPath,
      "--witness",
      witnessPath,
      "--receipt",
      receiptPath,
    ]);
    const proof = JSON.parse(await readFile(receiptPath, "utf8"));
    validateRealProofPrivacy(proof);
    return {
      proof,
      puzzle: { id: context.id, title: context.title },
      prover: {
        backend: proof.backend,
        prove_ms: proof.prove_ms,
        output: output.trim(),
      },
    };
  } finally {
    await rm(session, { recursive: true, force: true });
  }
}

async function makeSession(runtimeRoot, prefix) {
  await mkdir(runtimeRoot, { recursive: true });
  const name = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const path = join(runtimeRoot, name);
  await mkdir(path);
  return path;
}

