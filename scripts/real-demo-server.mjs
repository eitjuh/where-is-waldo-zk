#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  loadPublicConfigPayload,
  loadRealCatalogSnapshot,
} from "../src/real-catalog-runtime.mjs";
import { validateRealProofPrivacy } from "../src/real-demo.mjs";
import { proveRealWitness } from "../src/real-prove.mjs";
import { bytesToHex, prettyJson } from "../src/shared-core.mjs";
import { generateRealWitness } from "../src/witness-core.mjs";

const root = resolve(".");
const webRoot = resolve("apps/real-demo");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4174", 10);
const runtimeRoot = resolve("demo/real/runtime");
const allowCoordinateWitness = process.env.ZK_WALDO_ALLOW_COORDINATE_WITNESS === "1";
const trustRemote = process.env.ZK_WALDO_TRUST_REMOTE === "1";

if (host === "0.0.0.0" && !trustRemote) {
  console.error("Refusing to bind 0.0.0.0 without ZK_WALDO_TRUST_REMOTE=1.");
  process.exit(1);
}

let snapshot = await loadRealCatalogSnapshot();
let proving = false;
const proveBuckets = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const server = createServer(async (request, response) => {
  applySecurityHeaders(response);
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(response, 200, { ok: true, backend: "risc0-zkvm-3.0.5-real-cnn" });
    }
    if (request.method === "GET" && url.pathname === "/api/real/config") {
      snapshot = await loadRealCatalogSnapshot();
      return sendJson(response, 200, await loadPublicConfigPayload(snapshot));
    }
    if (request.method === "POST" && url.pathname === "/api/real/prove") {
      return await proveWitness(request, response);
    }
    if (request.method === "POST" && url.pathname === "/api/real/verify") {
      return await verifySubmittedProof(request, response);
    }
    if (request.method === "GET") {
      return serveStatic(url.pathname, response);
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`zk-waldo real CNN demo: http://${host}:${port}/`);
  console.log(
    allowCoordinateWitness
      ? "Warning: coordinate-based witness building is enabled (not for production)."
      : "Prove API accepts client-built witnesses only; coordinates stay in the browser.",
  );
});

async function proveWitness(request, response) {
  if (proving) {
    return sendJson(response, 409, { error: "A proof is already being generated." });
  }
  if (!allowRemoteProve(request)) {
    return sendJson(response, 403, {
      error: "Remote proving is disabled. Run the prover on localhost or set ZK_WALDO_TRUST_REMOTE=1.",
    });
  }
  if (!consumeProveBudget(request)) {
    return sendJson(response, 429, { error: "Prove rate limit exceeded. Try again shortly." });
  }

  proving = true;
  try {
    snapshot = await loadRealCatalogSnapshot();
    const body = await readJsonBody(request, 500_000);
    const context = snapshot.contextsById.get(body.puzzle_id);
    if (!context) {
      return sendJson(response, 400, { error: "Unknown puzzle selection." });
    }

    const witness = await resolveWitness(body, context);
    const result = await proveRealWitness({
      witness,
      context,
      runtimeRoot: join(runtimeRoot, "remote-prover"),
    });
    sendJson(response, 200, result);
  } finally {
    proving = false;
  }
}

async function resolveWitness(body, context) {
  if (body.witness) {
    return body.witness;
  }
  if (!allowCoordinateWitness) {
    throw new Error(
      "Send a client-built witness. Coordinate-based proving is disabled on this server.",
    );
  }
  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error("x and y must be integer pixel coordinates when witness is omitted.");
  }
  return generateRealWitness({
    pixels: context.puzzle.pixels,
    commitment: context.commitment,
    x,
    y,
  });
}

async function verifySubmittedProof(request, response) {
  let session;
  try {
    const body = await readJsonBody(request, 2_000_000);
    const proof = body.proof ?? body;
    validateRealProofPrivacy(proof);
    snapshot = await loadRealCatalogSnapshot();
    const context = contextForProof(proof);
    session = await makeSession("verify");
    const receiptPath = join(session, "submitted-proof.risc0.json");
    await writeFile(receiptPath, prettyJson(proof), "utf8");
    const output = await runHost([
      "run",
      "-p",
      "zk-waldo-zkvm-host",
      "--",
      "verify-real",
      "--commitment",
      context.config.commitmentPath,
      "--receipt",
      receiptPath,
    ]);
    sendJson(response, 200, {
      valid: true,
      statement:
        "The prover knows a private crop from this committed real puzzle image that passes the trained CNN.",
      backend: proof.backend,
      puzzle: { id: context.id, title: context.title, image_root: context.commitment.image_root },
      output: output.trim(),
    });
  } catch (error) {
    sendJson(response, 422, { valid: false, error: error.message });
  } finally {
    if (session) {
      await rm(session, { recursive: true, force: true });
    }
  }
}

function allowRemoteProve(request) {
  if (trustRemote || host === "127.0.0.1" || host === "localhost") {
    return true;
  }
  const remote = request.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function consumeProveBudget(request) {
  const key = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const limit = Number.parseInt(process.env.ZK_WALDO_PROVE_RATE_LIMIT ?? "6", 10);
  const bucket = proveBuckets.get(key) ?? [];
  const recent = bucket.filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    proveBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  proveBuckets.set(key, recent);
  return true;
}

function applySecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function serveStatic(pathname, response) {
  const normalized = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(join(webRoot, normalized));
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}/`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": mime[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

function contextForProof(proof) {
  const root = proof?.public_output?.public_inputs?.image_root;
  if (
    !Array.isArray(root) ||
    root.length !== 32 ||
    root.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    throw new Error("Proof does not contain a valid public image root.");
  }
  const context = snapshot.contextsByRoot.get(bytesToHex(Uint8Array.from(root)));
  if (!context) {
    throw new Error("Proof image root is not in this puzzle catalog.");
  }
  return context;
}

async function makeSession(prefix) {
  await mkdir(runtimeRoot, { recursive: true });
  const name = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const path = join(runtimeRoot, name);
  await mkdir(path);
  return path;
}

function runHost(args, extraEnv = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("cargo", args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectCommand(new Error("RISC Zero host command timed out."));
    }, 10 * 60 * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolveCommand(stdout);
      } else {
        rejectCommand(new Error(lastUsefulLine(stderr || stdout) || `host exited with code ${code}`));
      }
    });
  });
}

function lastUsefulLine(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

async function readJsonBody(request, limit = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
