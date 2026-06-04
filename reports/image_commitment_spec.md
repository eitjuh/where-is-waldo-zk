# Image Commitment Spec

This demo commits each canonical public puzzle image into its own deterministic
Merkle root. The verifier identifies the relevant catalog page from the root
inside the receipt's public journal.

## Canonical Image Rules

- Input format: non-interlaced 8-bit PNG, RGB or RGBA.
- Canonical pixels: RGB `uint8`, row-major, alpha discarded.
- Main real-demo dimensions: `1024x1024`.
- Crop: `64x64`, top-left anchored.
- Tile size: `64x64`, RGB.
- MVP alignment: crop `x` and `y` must be multiples of `64`.

## Leaf Hash

Each leaf is:

```text
sha256("zk-waldo.tile.v0:" || u32be(tile_x) || u32be(tile_y) || tile_rgb_bytes)
```

## Node Hash

Each internal node is:

```text
sha256("zk-waldo.merkle.node.v0:" || left_hash || right_hash)
```

Odd nodes are duplicated at that level.

## Privacy Boundary

Merkle paths, leaf indices, tile coordinates, tile pixels, crop pixels, and
`x,y` are private witness values. The receipt exposes only public inputs:

```text
image_root
model_hash
preprocessing_hash
threshold_logit
image_width
image_height
crop_width
crop_height
tile_size
```
