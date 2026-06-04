import {
  assertAlignedCrop,
  bytesToHex,
  extractCropFromPixels,
  hexToBytes,
} from "./shared-core.mjs";
import { buildMerkleTree, getMerklePath, hashTile, splitTiles, verifyMerklePath } from "./merkle.mjs";

export const REAL_IMAGE_CONFIG = Object.freeze({
  width: 1024,
  height: 1024,
  tileSize: 64,
  cropSize: 64,
});

export function commitRealPixels({ pixels, model, config }) {
  const imageId = config.imageId;
  const { tileColumns, tileRows, tiles } = splitTiles({
    pixels,
    width: config.width ?? REAL_IMAGE_CONFIG.width,
    height: config.height ?? REAL_IMAGE_CONFIG.height,
    tileSize: config.tileSize ?? REAL_IMAGE_CONFIG.tileSize,
  });
  const tree = buildMerkleTree(tiles.map((tile) => tile.leaf));
  return {
    schema: "zk-waldo-image-commitment-v1",
    image_id: imageId,
    image_width: config.width ?? REAL_IMAGE_CONFIG.width,
    image_height: config.height ?? REAL_IMAGE_CONFIG.height,
    crop_width: config.cropSize ?? REAL_IMAGE_CONFIG.cropSize,
    crop_height: config.cropSize ?? REAL_IMAGE_CONFIG.cropSize,
    tile_size: config.tileSize ?? REAL_IMAGE_CONFIG.tileSize,
    tile_columns: tileColumns,
    tile_rows: tileRows,
    leaf_count: tiles.length,
    hash_function: "sha256-domain-separated-v0",
    image_root: bytesToHex(tree.root),
    preprocessing_hash: model.preprocessing_hash,
  };
}

export function generateRealWitness({ pixels, commitment, x, y, config = REAL_IMAGE_CONFIG }) {
  assertAlignedCrop({
    x,
    y,
    imageWidth: commitment.image_width,
    imageHeight: commitment.image_height,
    cropSize: commitment.crop_height,
    tileSize: commitment.tile_size,
  });
  const { tileColumns, tiles } = splitTiles({
    pixels,
    width: commitment.image_width,
    height: commitment.image_height,
    tileSize: commitment.tile_size,
  });
  const tree = buildMerkleTree(tiles.map((tile) => tile.leaf));
  if (bytesToHex(tree.root) !== commitment.image_root) {
    throw new Error("puzzle pixels do not match the public image commitment");
  }
  const tileX = x / commitment.tile_size;
  const tileY = y / commitment.tile_size;
  const leafIndex = tileY * tileColumns + tileX;
  const tile = tiles[leafIndex];
  const cropPixels = extractCropFromPixels(
    pixels,
    commitment.image_width,
    commitment.image_height,
    x,
    y,
    commitment.crop_height,
  );
  return {
    schema: "zk-waldo-private-witness-v1",
    x,
    y,
    crop_width: commitment.crop_width,
    crop_height: commitment.crop_height,
    crop_pixels: bytesToHex(cropPixels),
    tiles: [
      {
        tile_x: tileX,
        tile_y: tileY,
        leaf_index: leafIndex,
        pixels: bytesToHex(tile.pixels),
        merkle_path: getMerklePath(tree, leafIndex),
      },
    ],
  };
}

export function validateRealWitness(witness, commitment) {
  if (witness?.schema !== "zk-waldo-private-witness-v1") {
    throw new Error("witness schema is invalid");
  }
  if (!Array.isArray(witness.tiles) || witness.tiles.length !== 1) {
    throw new Error("witness must contain exactly one tile");
  }
  const tile = witness.tiles[0];
  const x = Number(witness.x);
  const y = Number(witness.y);
  assertAlignedCrop({
    x,
    y,
    imageWidth: commitment.image_width,
    imageHeight: commitment.image_height,
    cropSize: commitment.crop_height,
    tileSize: commitment.tile_size,
  });
  if (tile.tile_x !== x / commitment.tile_size || tile.tile_y !== y / commitment.tile_size) {
    throw new Error("witness tile coordinates do not match x and y");
  }
  const cropPixels = hexToBytes(witness.crop_pixels);
  const tilePixels = hexToBytes(tile.pixels);
  if (cropPixels.length !== tilePixels.length || !cropPixels.every((value, index) => value === tilePixels[index])) {
    throw new Error("witness crop must equal the committed tile pixels");
  }
  const leaf = hashTile({ tileX: tile.tile_x, tileY: tile.tile_y, pixels: tilePixels });
  if (
    !verifyMerklePath({
      leaf,
      leafIndex: tile.leaf_index,
      path: tile.merkle_path,
      expectedRoot: commitment.image_root,
    })
  ) {
    throw new Error("witness Merkle path does not match the public image root");
  }
  return { x, y, cropPixels, tile };
}
