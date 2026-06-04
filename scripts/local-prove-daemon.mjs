#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve } from "node:path";
import { loadRealCatalogSnapshot } from "../src/real-catalog-runtime.mjs";
import { proveRealWitness } from "../src/real-prove.mjs";

const host = process.env.ZK_WALDO_PROVER_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.ZK_WALDO_PROVER_PORT ?? "4175", 10);
const runtimeRoot = resolve("demo/real/runtime/local-prover");

if (host !== "127.0.0.1" && host !== "localhost") {
  console.error("Local prove daemon must bind to loopback.");
  process.exit(1);
}

let snapshot = await loadRealCatalogSnapshot({ force: true });
let proving = false;

const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Access-Control-Allow-Origin", "null");
  response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(response, 200, { ok: true, role: "local-prover" });
    }
    if (request.method === "POST" && url.pathname === "/api/real/prove") {
      return await handleProve(request, response);
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message, code: error.code });
  }
});

server.listen(port, host, () => {
  console.log(`zk-waldo local prover: http://${host}:${port}/`);
  console.log("Accepts client-built witnesses only. Coordinates never hit this API.");
});

async function handleProve(request, response) {
  if (proving) {
    return sendJson(response, 409, { error: "A proof is already being generated." });
  }
  proving = true;
  try {
    snapshot = await loadRealCatalogSnapshot({ force: true });
    const body = await readJsonBody(request);
    if (!body.witness) {
      return sendJson(response, 400, {
        error: "Local prover requires a client-built witness payload.",
      });
    }
    const context = snapshot.contextsById.get(body.puzzle_id);
    if (!context) {
      return sendJson(response, 400, { error: "Unknown puzzle selection." });
    }
    const result = await proveRealWitness({
      witness: body.witness,
      context,
      runtimeRoot,
    });
    sendJson(response, 200, result);
  } catch (error) {
    const status = error.code === "CNN_REJECTED" ? 422 : 500;
    sendJson(response, status, { error: error.message, code: error.code });
  } finally {
    proving = false;
  }
}

async function readJsonBody(request, limit = 500_000) {
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
