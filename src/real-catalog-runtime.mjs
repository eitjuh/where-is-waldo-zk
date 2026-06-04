import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareRealCatalog, REAL_CONFIG } from "./real-demo.mjs";
import { loadSignedModelRegistry } from "./model-registry.mjs";

let snapshotPromise;
let snapshotMtimeMs = -1;

export async function loadRealCatalogSnapshot({ force = false } = {}) {
  const catalogPath = resolve(REAL_CONFIG.publicCatalogPath);
  const { mtimeMs } = await stat(catalogPath);
  if (!force && snapshotPromise && snapshotMtimeMs === mtimeMs) {
    return snapshotPromise;
  }
  snapshotMtimeMs = mtimeMs;
  snapshotPromise = prepareRealCatalog().then((catalog) => ({
    catalog,
    contextsById: new Map(catalog.puzzles.map((puzzle) => [puzzle.id, puzzle])),
    contextsByRoot: new Map(
      catalog.puzzles.map((puzzle) => [puzzle.commitment.image_root, puzzle]),
    ),
    defaultContext: catalog.puzzles.find(
      (puzzle) => puzzle.id === catalog.publicCatalog.default_puzzle_id,
    ),
  }));
  return snapshotPromise;
}

export async function loadPublicConfigPayload(snapshot) {
  const { catalog, defaultContext } = snapshot;
  const model = catalog.model;
  return {
    schema: "zk-waldo-real-config-v1",
    default_puzzle_id: catalog.publicCatalog.default_puzzle_id,
    model_id: model.model_id,
    model_hash: model.model_hash,
    preprocessing_hash: model.preprocessing_hash,
    threshold_logit: model.threshold_logit,
    dimensions: {
      image: [defaultContext.commitment.image_width, defaultContext.commitment.image_height],
      crop: [defaultContext.commitment.crop_width, defaultContext.commitment.crop_height],
      tile_size: defaultContext.commitment.tile_size,
      cnn_input: model.architecture.input,
    },
    metrics: model.metrics,
    prove_mode: "witness-only",
    puzzles: catalog.puzzles.map((puzzle) => ({
      id: puzzle.id,
      title: puzzle.title,
      image_url: `/assets/puzzles/${puzzle.id}.png`,
      image_id: puzzle.commitment.image_id,
      image_root: puzzle.commitment.image_root,
      commitment: puzzle.commitment,
    })),
    backend: "risc0-zkvm-3.0.5-real-cnn",
    registry: await loadSignedModelRegistry(),
    local_prover_url: `http://${process.env.ZK_WALDO_PROVER_HOST ?? "127.0.0.1"}:${process.env.ZK_WALDO_PROVER_PORT ?? "4175"}/api/real/prove`,
    prefer_local_prover: process.env.ZK_WALDO_PREFER_LOCAL_PROVER !== "0",
    require_local_prover: process.env.ZK_WALDO_REQUIRE_LOCAL_PROVER === "1",
    server_prove_hint:
      process.env.ZK_WALDO_PREFER_LOCAL_PROVER === "0"
        ? "Server proving on this VPS is much slower than a local Mac (~20s). For a fast demo, run pnpm real:prove:daemon and pnpm real:serve on your laptop."
        : null,
  };
}
