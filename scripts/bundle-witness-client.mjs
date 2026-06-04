#!/usr/bin/env node
import * as esbuild from "esbuild";
import { resolve } from "node:path";

const root = resolve(".");
const outfile = resolve(root, "apps/real-demo/witness-client.bundle.js");

await esbuild.build({
  entryPoints: [resolve(root, "apps/real-demo/witness-client.mjs")],
  external: [],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile,
  sourcemap: true,
  logLevel: "info",
});

console.log(`witness client bundle: ${outfile}`);
