import { pixelsFromPngUrl } from "../../src/browser-puzzle.mjs";
import { generateRealWitness } from "../../src/witness-core.mjs";

export async function buildWitnessFromClick({ imageUrl, commitment, x, y }) {
  const pixels = await pixelsFromPngUrl(imageUrl);
  return generateRealWitness({ pixels, commitment, x, y });
}
