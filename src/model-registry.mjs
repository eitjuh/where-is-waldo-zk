import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stableJson, textBytes } from "./shared-core.mjs";

const DEFAULT_PUBLIC_KEY_PATH = "models/release.pub";

export async function loadSignedModelRegistry(path = "models/registry.json") {
  const registry = JSON.parse(await readFile(resolve(path), "utf8"));
  await verifyModelRegistrySignature(registry);
  return registry;
}

export async function verifyModelRegistrySignature(
  registry,
  publicKeyPath = DEFAULT_PUBLIC_KEY_PATH,
) {
  const signature = registry.signature;
  if (!signature || typeof signature !== "string") {
    throw new Error("model registry is missing an Ed25519 signature");
  }
  const publicKeyPem = await readFile(resolve(publicKeyPath), "utf8");
  const publicKey = createPublicKey(publicKeyPem);
  const payload = registryPayload(registry);
  const valid = verify(null, textBytes(payload), publicKey, Buffer.from(signature, "base64"));
  if (!valid) {
    throw new Error("model registry signature verification failed");
  }
  return registry;
}

export function registryPayload(registry) {
  return stableJson({
    schema: registry.schema,
    models: registry.models,
  });
}

export function findRegistryModel(registry, modelId) {
  const entry = registry.models?.find((model) => model.model_id === modelId);
  if (!entry) {
    throw new Error(`model registry does not contain ${modelId}`);
  }
  return entry;
}
