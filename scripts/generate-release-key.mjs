#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPath = resolve("models/release.pub");
const privatePath = resolve("models/release.pem");

await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }), "utf8");
await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
console.log(`wrote ${publicPath}`);
console.log(`wrote ${privatePath} (keep private; gitignored)`);
