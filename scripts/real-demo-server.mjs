#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  generateRealWitness,
  prepareRealCatalog,
  realPublicSummary,
  validateRealProofPrivacy,
} from "../src/real-demo.mjs";
import { realCnnLogit } from "../src/quantized-cnn.mjs";
import { bytesToHex, hexToBytes, prettyJson } from "../src/shared-core.mjs";

const root = resolve(".");
const webRoot = resolve("apps/real-demo");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4174", 10);
const runtimeRoot = resolve("demo/real/runtime");
const catalog = await prepareRealCatalog();
const contextsById = new Map(catalog.puzzles.map((puzzle) => [puzzle.id, puzzle]));
const contextsByRoot = new Map(
  catalog.puzzles.map((puzzle) => [puzzle.commitment.image_root, puzzle]),
);
const defaultContext = contextsById.get(catalog.publicCatalog.default_puzzle_id);
let proving = false;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/real/config") {
      return sendJson(response, 200, {
        ...realPublicSummary(defaultContext),
        default_puzzle_id: catalog.publicCatalog.default_puzzle_id,
        puzzles: catalog.puzzles.map((puzzle) => ({
          id: puzzle.id,
          title: puzzle.title,
          image_url: `/assets/puzzles/${puzzle.id}.png`,
          image_id: puzzle.commitment.image_id,
          image_root: puzzle.commitment.image_root,
        })),
        backend: "risc0-zkvm-3.0.5-real-cnn",
      });
    }
    if (request.method === "POST" && url.pathname === "/api/real/prove") {
      return await proveSelection(request, response);
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
});

async function proveSelection(request, response) {
  if (proving) {
    return sendJson(response, 409, { error: "A proof is already being generated." });
  }
  proving = true;
  let session;
  try {
    const body = await readJsonBody(request);
    const context = contextsById.get(body.puzzle_id);
    if (!context) {
      return sendJson(response, 400, { error: "Unknown puzzle selection." });
    }
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return sendJson(response, 400, { error: "x and y must be integer pixel coordinates." });
    }
    const witness = generateRealWitness({
      pixels: context.puzzle.pixels,
      commitment: context.commitment,
      x,
      y,
      config: context.config,
    });
    const logit = realCnnLogit(hexToBytes(witness.crop_pixels), context.model);
    if (logit < context.model.threshold_logit) {
      return sendJson(response, 422, {
        error: "The trained CNN rejected that private tile.",
        code: "CNN_REJECTED",
      });
    }

    session = await makeSession("prove");
    const witnessPath = join(session, "witness.private.json");
    const receiptPath = join(session, "proof.risc0.json");
    await writeFile(witnessPath, prettyJson(witness), "utf8");
    const output = await runHost(
      [
        "run",
        "-p",
        "zk-waldo-zkvm-host",
        "--",
        "prove-real",
        "--commitment",
        context.config.commitmentPath,
        "--witness",
        witnessPath,
        "--receipt",
        receiptPath,
      ],
      { RISC0_PROVER: "ipc" },
    );
    const proof = JSON.parse(await readFile(receiptPath, "utf8"));
    validateRealProofPrivacy(proof);
    sendJson(response, 200, {
      proof,
      puzzle: { id: context.id, title: context.title },
      prover: {
        backend: proof.backend,
        prove_ms: proof.prove_ms,
        output: output.trim(),
      },
    });
  } finally {
    proving = false;
    if (session) {
      await rm(session, { recursive: true, force: true });
    }
  }
}

async function verifySubmittedProof(request, response) {
  let session;
  try {
    const body = await readJsonBody(request, 2_000_000);
    const proof = body.proof ?? body;
    validateRealProofPrivacy(proof);
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
  const context = contextsByRoot.get(bytesToHex(Uint8Array.from(root)));
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
