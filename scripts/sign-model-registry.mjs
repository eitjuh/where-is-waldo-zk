#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, sign } from "node:crypto";
import { resolve } from "node:path";
import { registryPayload } from "../src/model-registry.mjs";
import { prettyJson } from "../src/shared-core.mjs";

const registryPath = resolve("models/registry.json");
const privateKeyPath = resolve(process.env.ZK_WALDO_RELEASE_KEY ?? "models/release.pem");

const registry = JSON.parse(await readFile(registryPath, "utf8"));
registry.schema ??= "zk-waldo-model-registry-v1";
registry.signing_key_id = "zk-waldo-release-v1";
const privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"));
const signature = sign(null, Buffer.from(registryPayload(registry), "utf8"), privateKey);

registry.signature = signature.toString("base64");
registry.signed_at = "2026-06-04T00:00:00.000Z";

await writeFile(registryPath, prettyJson(registry), "utf8");
console.log(`signed ${registryPath}`);
