import { createHash } from "node:crypto";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  textBytes,
  u32be,
} from "./shared-core.mjs";

export function sha256Bytes(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function sha256Hex(bytes) {
  return bytesToHex(sha256Bytes(bytes instanceof Uint8Array ? bytes : textBytes(String(bytes))));
}

export function domainHash(label, parts) {
  return sha256Bytes(concatBytes([textBytes(`${label}:`), ...parts]));
}

export function splitTiles({ pixels, width, height, tileSize }) {
  if (width % tileSize !== 0 || height % tileSize !== 0) {
    throw new Error("image dimensions must be divisible by tile size");
  }

  const tileColumns = width / tileSize;
  const tileRows = height / tileSize;
  const tiles = [];

  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      const tilePixels = new Uint8Array(tileSize * tileSize * 3);
      for (let row = 0; row < tileSize; row += 1) {
        const srcStart = ((tileY * tileSize + row) * width + tileX * tileSize) * 3;
        const srcEnd = srcStart + tileSize * 3;
        tilePixels.set(srcPixels(pixels, srcStart, srcEnd), row * tileSize * 3);
      }
      const leafIndex = tileY * tileColumns + tileX;
      tiles.push({
        tileX,
        tileY,
        leafIndex,
        pixels: tilePixels,
        leaf: hashTile({ tileX, tileY, pixels: tilePixels }),
      });
    }
  }

  return { tileColumns, tileRows, tiles };
}

function srcPixels(pixels, start, end) {
  return pixels.subarray(start, end);
}

export function hashTile({ tileX, tileY, pixels }) {
  return domainHash("zk-waldo.tile.v0", [u32be(tileX), u32be(tileY), pixels]);
}

export function hashMerkleNode(left, right) {
  return domainHash("zk-waldo.merkle.node.v0", [left, right]);
}

export function buildMerkleTree(leaves) {
  if (leaves.length === 0) {
    throw new Error("cannot build an empty Merkle tree");
  }

  const levels = [leaves.map((leaf) => new Uint8Array(leaf))];
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1);
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? current[i];
      next.push(hashMerkleNode(left, right));
    }
    levels.push(next);
  }

  return {
    levels,
    root: levels.at(-1)[0],
  };
}

export function getMerklePath(tree, leafIndex) {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.levels[0].length) {
    throw new Error(`invalid leaf index ${leafIndex}`);
  }

  const path = [];
  let index = leafIndex;
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    const sibling = nodes[siblingIndex] ?? nodes[index];
    path.push({
      sibling: bytesToHex(sibling),
      direction: isRight ? "left" : "right",
    });
    index = Math.floor(index / 2);
  }
  return path;
}

export function verifyMerklePath({ leaf, leafIndex, path, expectedRoot }) {
  let current = leaf;
  let index = leafIndex;

  for (const step of path) {
    const sibling = typeof step.sibling === "string" ? hexToBytes(step.sibling) : step.sibling;
    const siblingIsLeft = step.direction === "left";
    const expectedDirection = index % 2 === 1 ? "left" : "right";
    if (step.direction !== expectedDirection) {
      return false;
    }
    current = siblingIsLeft ? hashMerkleNode(sibling, current) : hashMerkleNode(current, sibling);
    index = Math.floor(index / 2);
  }

  return bytesToHex(current) === (typeof expectedRoot === "string" ? expectedRoot : bytesToHex(expectedRoot));
}
