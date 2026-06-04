#!/usr/bin/env node
import { prepareRealCatalog } from "../src/real-demo.mjs";

const result = await prepareRealCatalog({ writeWitnesses: true });
console.log(`real puzzle catalog: ${result.puzzles.length} puzzles`);
console.log(`model_hash: ${result.model.model_hash}`);
console.log(`threshold_logit: ${result.model.threshold_logit}`);
for (const puzzle of result.puzzles) {
  console.log(
    `${puzzle.id}: root=${puzzle.commitment.image_root} target_private_logit=${puzzle.logit}`,
  );
}
