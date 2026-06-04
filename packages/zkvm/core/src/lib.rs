#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

mod cnn_weights;

use alloc::vec;
use alloc::vec::Vec;
pub use cnn_weights::{
    REAL_CNN_CONV_BIASES, REAL_CNN_CONV_WEIGHTS, REAL_CNN_DENSE_BIAS, REAL_CNN_DENSE_FEATURES,
    REAL_CNN_DENSE_WEIGHTS, REAL_CNN_FILTERS, REAL_CNN_INPUT_SIZE, REAL_CNN_KERNEL,
    REAL_CNN_MODEL_HASH, REAL_CNN_OUT_SIZE, REAL_CNN_PREPROCESSING_HASH, REAL_CNN_STRIDE,
    REAL_CNN_THRESHOLD,
};
use serde::{Deserialize, Serialize};

#[cfg(feature = "risc0-sha")]
use risc0_zkvm::sha::rust_crypto::{Digest, Sha256};
#[cfg(not(feature = "risc0-sha"))]
use sha2::{Digest, Sha256};

pub const FULL_WIDTH: u32 = 512;
pub const FULL_HEIGHT: u32 = 384;
pub const FULL_TILE_SIZE: u32 = 32;
pub const FULL_CROP_SIZE: u32 = 64;
pub const TINY_WIDTH: u32 = 32;
pub const TINY_HEIGHT: u32 = 32;
pub const TINY_TILE_SIZE: u32 = 16;
pub const TINY_CROP_SIZE: u32 = 16;
pub const REAL_WIDTH: u32 = 1024;
pub const REAL_HEIGHT: u32 = 1024;
pub const REAL_TILE_SIZE: u32 = 64;
pub const REAL_CROP_SIZE: u32 = 64;

pub const FULL_MODEL_HASH: [u8; 32] = [
    0x70, 0xe1, 0xc1, 0x66, 0x16, 0x8a, 0x09, 0xfc, 0xac, 0x65, 0x4a, 0xdb, 0xdd, 0xc2, 0xf5, 0xf0,
    0xca, 0xb7, 0xca, 0x68, 0xde, 0xb4, 0x97, 0x98, 0x45, 0x8e, 0x08, 0x58, 0x62, 0xe6, 0xd0, 0x69,
];
pub const FULL_PREPROCESSING_HASH: [u8; 32] = [
    0x44, 0xdf, 0x07, 0x8d, 0xf1, 0x68, 0xad, 0xc2, 0x17, 0x80, 0xd4, 0x21, 0xe6, 0x81, 0x0a, 0x4d,
    0xc8, 0x0e, 0x58, 0xfa, 0x3d, 0xe3, 0x12, 0x59, 0xc4, 0xb9, 0x96, 0x32, 0xad, 0xbd, 0x3e, 0x12,
];
pub const TINY_MODEL_HASH: [u8; 32] = [
    0x66, 0xb3, 0x1e, 0xfd, 0xc7, 0x2d, 0x9b, 0x1a, 0x01, 0x27, 0x33, 0x98, 0xb6, 0x5a, 0x47, 0x55,
    0x53, 0xa1, 0xe3, 0x51, 0x39, 0x6a, 0x2e, 0x92, 0x1d, 0x8c, 0x65, 0x3e, 0xf1, 0x1b, 0x46, 0xfa,
];
pub const TINY_PREPROCESSING_HASH: [u8; 32] = [
    0x0e, 0x94, 0x6b, 0x3f, 0xbd, 0x3c, 0xa1, 0xee, 0x96, 0x4e, 0x86, 0x5c, 0xd7, 0xfd, 0xb7, 0xc4,
    0xda, 0x3f, 0xc4, 0x79, 0x33, 0x33, 0x39, 0xd1, 0x71, 0x9e, 0x88, 0xb9, 0xe2, 0x74, 0x62, 0x05,
];

const RED: [u8; 3] = [206, 34, 46];
const WHITE: [u8; 3] = [248, 246, 235];
const BLUE: [u8; 3] = [42, 89, 176];
const SKIN: [u8; 3] = [238, 183, 132];
const INK: [u8; 3] = [30, 34, 40];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PublicInputs {
    pub image_root: [u8; 32],
    pub model_hash: [u8; 32],
    pub preprocessing_hash: [u8; 32],
    pub threshold_logit: i32,
    pub image_width: u32,
    pub image_height: u32,
    pub crop_width: u32,
    pub crop_height: u32,
    pub tile_size: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GuestInput {
    pub public_inputs: PublicInputs,
    pub witness: PrivateWitness,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PrivateWitness {
    pub x: u32,
    pub y: u32,
    pub crop_width: u32,
    pub crop_height: u32,
    pub crop_pixels: Vec<u8>,
    pub tiles: Vec<TileWitness>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TileWitness {
    pub tile_x: u32,
    pub tile_y: u32,
    pub leaf_index: u32,
    pub pixels: Vec<u8>,
    pub merkle_path: Vec<MerkleStep>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MerkleStep {
    pub sibling: [u8; 32],
    pub direction: Direction,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Direction {
    Left,
    Right,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PublicOutput {
    pub public_inputs: PublicInputs,
    pub accepted: bool,
}

pub fn prove_statement(input: &GuestInput) -> PublicOutput {
    validate_public_inputs(&input.public_inputs);
    let crop = verify_witness_and_recover_crop(&input.public_inputs, &input.witness);
    let logit = if input.public_inputs.model_hash == REAL_CNN_MODEL_HASH {
        real_cnn_logit(&crop)
    } else {
        detector_logit(&crop, input.public_inputs.crop_width)
    };
    assert!(
        logit >= input.public_inputs.threshold_logit,
        "classifier logit is below threshold"
    );

    PublicOutput {
        public_inputs: input.public_inputs.clone(),
        accepted: true,
    }
}

pub fn validate_public_inputs(public: &PublicInputs) {
    let is_full = public.image_width == FULL_WIDTH
        && public.image_height == FULL_HEIGHT
        && public.crop_width == FULL_CROP_SIZE
        && public.crop_height == FULL_CROP_SIZE
        && public.tile_size == FULL_TILE_SIZE;
    let is_tiny = public.image_width == TINY_WIDTH
        && public.image_height == TINY_HEIGHT
        && public.crop_width == TINY_CROP_SIZE
        && public.crop_height == TINY_CROP_SIZE
        && public.tile_size == TINY_TILE_SIZE;
    let is_real = public.image_width == REAL_WIDTH
        && public.image_height == REAL_HEIGHT
        && public.crop_width == REAL_CROP_SIZE
        && public.crop_height == REAL_CROP_SIZE
        && public.tile_size == REAL_TILE_SIZE;

    if is_full {
        assert_eq!(public.model_hash, FULL_MODEL_HASH, "unexpected model hash");
        assert_eq!(
            public.preprocessing_hash, FULL_PREPROCESSING_HASH,
            "unexpected preprocessing hash"
        );
    } else if is_tiny {
        assert_eq!(
            public.model_hash, TINY_MODEL_HASH,
            "unexpected tiny model hash"
        );
        assert_eq!(
            public.preprocessing_hash, TINY_PREPROCESSING_HASH,
            "unexpected tiny preprocessing hash"
        );
    } else if is_real {
        assert_eq!(
            public.model_hash, REAL_CNN_MODEL_HASH,
            "unexpected real CNN model hash"
        );
        assert_eq!(
            public.preprocessing_hash, REAL_CNN_PREPROCESSING_HASH,
            "unexpected real CNN preprocessing hash"
        );
        assert_eq!(
            public.threshold_logit, REAL_CNN_THRESHOLD,
            "unexpected real CNN threshold"
        );
    } else {
        panic!("unsupported public input dimensions");
    }
}

pub fn verify_witness_and_recover_crop(public: &PublicInputs, witness: &PrivateWitness) -> Vec<u8> {
    let crop_size = public.crop_width as usize;
    let tile_size = public.tile_size as usize;
    let crop_bytes = crop_size * crop_size * 3;
    let tile_bytes = tile_size * tile_size * 3;

    assert_eq!(
        public.crop_width, public.crop_height,
        "only square crops are supported"
    );
    assert_eq!(
        witness.crop_width, public.crop_width,
        "unexpected witness crop width"
    );
    assert_eq!(
        witness.crop_height, public.crop_height,
        "unexpected witness crop height"
    );
    assert!(
        witness.x + public.crop_width <= public.image_width,
        "crop x out of bounds"
    );
    assert!(
        witness.y + public.crop_height <= public.image_height,
        "crop y out of bounds"
    );
    assert_eq!(
        witness.x % public.tile_size,
        0,
        "crop x is not tile-aligned"
    );
    assert_eq!(
        witness.y % public.tile_size,
        0,
        "crop y is not tile-aligned"
    );
    assert_eq!(
        witness.crop_pixels.len(),
        crop_bytes,
        "bad crop byte length"
    );

    let tile_columns = public.image_width / public.tile_size;
    let tiles_per_side = public.crop_width / public.tile_size;
    let expected_tile_count = (tiles_per_side * tiles_per_side) as usize;
    assert_eq!(
        witness.tiles.len(),
        expected_tile_count,
        "wrong private tile witness count"
    );

    let start_tile_x = witness.x / public.tile_size;
    let start_tile_y = witness.y / public.tile_size;
    let mut recovered = vec![0_u8; crop_bytes];

    for dy in 0..tiles_per_side {
        for dx in 0..tiles_per_side {
            let tile_x = start_tile_x + dx;
            let tile_y = start_tile_y + dy;
            let tile = witness
                .tiles
                .iter()
                .find(|tile| tile.tile_x == tile_x && tile.tile_y == tile_y)
                .expect("missing required private tile witness");

            assert_eq!(tile.pixels.len(), tile_bytes, "bad tile byte length");
            let expected_leaf_index = tile_y * tile_columns + tile_x;
            assert_eq!(
                tile.leaf_index, expected_leaf_index,
                "leaf index does not match private tile coordinate"
            );

            let leaf = hash_tile(tile.tile_x, tile.tile_y, &tile.pixels);
            assert!(
                verify_merkle_path(
                    &leaf,
                    tile.leaf_index,
                    &tile.merkle_path,
                    &public.image_root
                ),
                "invalid private Merkle path"
            );

            copy_tile_into_crop(
                &mut recovered,
                &tile.pixels,
                dx as usize,
                dy as usize,
                crop_size,
                tile_size,
            );
        }
    }

    assert_eq!(
        recovered, witness.crop_pixels,
        "declared crop does not match committed tiles"
    );
    recovered
}

fn copy_tile_into_crop(
    recovered: &mut [u8],
    tile_pixels: &[u8],
    tile_dx: usize,
    tile_dy: usize,
    crop_size: usize,
    tile_size: usize,
) {
    for row in 0..tile_size {
        let src_start = row * tile_size * 3;
        let src_end = src_start + tile_size * 3;
        let dest_row = tile_dy * tile_size + row;
        let dest_column = tile_dx * tile_size;
        let dest_start = (dest_row * crop_size + dest_column) * 3;
        recovered[dest_start..dest_start + tile_size * 3]
            .copy_from_slice(&tile_pixels[src_start..src_end]);
    }
}

pub fn verify_merkle_path(
    leaf: &[u8; 32],
    leaf_index: u32,
    path: &[MerkleStep],
    expected_root: &[u8; 32],
) -> bool {
    let mut current = *leaf;
    let mut index = leaf_index;

    for step in path {
        let expected_direction = if index % 2 == 1 {
            Direction::Left
        } else {
            Direction::Right
        };
        if step.direction != expected_direction {
            return false;
        }

        current = match step.direction {
            Direction::Left => hash_merkle_node(&step.sibling, &current),
            Direction::Right => hash_merkle_node(&current, &step.sibling),
        };
        index /= 2;
    }

    &current == expected_root
}

pub fn hash_tile(tile_x: u32, tile_y: u32, pixels: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"zk-waldo.tile.v0:");
    hasher.update(tile_x.to_be_bytes());
    hasher.update(tile_y.to_be_bytes());
    hasher.update(pixels);
    hasher.finalize().into()
}

pub fn hash_merkle_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"zk-waldo.merkle.node.v0:");
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

pub fn detector_logit(crop_pixels: &[u8], crop_size: u32) -> i32 {
    let crop_size = crop_size as usize;
    assert_eq!(
        crop_pixels.len(),
        crop_size * crop_size * 3,
        "bad crop byte length"
    );
    let hat = region_color_score(
        crop_pixels,
        crop_size,
        scale(23, crop_size),
        scale(7, crop_size),
        scale(20, crop_size),
        scale(8, crop_size),
        RED,
    );
    let face = region_color_score(
        crop_pixels,
        crop_size,
        scale(25, crop_size),
        scale(15, crop_size),
        scale(16, crop_size),
        scale(13, crop_size),
        SKIN,
    );
    let glasses = region_color_score(
        crop_pixels,
        crop_size,
        scale(24, crop_size),
        scale(18, crop_size),
        scale(18, crop_size),
        scale(5, crop_size),
        INK,
    );
    let stripes = stripe_score(crop_pixels, crop_size);
    let pants = region_color_score(
        crop_pixels,
        crop_size,
        scale(23, crop_size),
        scale(45, crop_size),
        scale(21, crop_size),
        scale(14, crop_size),
        BLUE,
    );

    hat * 2 + face + glasses + stripes * 3 + pants * 2 - 1250
}

pub fn real_cnn_logit(crop_pixels: &[u8]) -> i32 {
    let crop_size = REAL_CROP_SIZE as usize;
    assert_eq!(
        crop_pixels.len(),
        crop_size * crop_size * 3,
        "bad real CNN crop byte length"
    );
    let box_size = crop_size / REAL_CNN_INPUT_SIZE;
    let pixels_per_box = box_size * box_size;
    let mut input = [0_u8; REAL_CNN_INPUT_SIZE * REAL_CNN_INPUT_SIZE * 3];
    for output_y in 0..REAL_CNN_INPUT_SIZE {
        for output_x in 0..REAL_CNN_INPUT_SIZE {
            for channel in 0..3 {
                let mut sum = 0_u32;
                for box_y in 0..box_size {
                    for box_x in 0..box_size {
                        let source_x = output_x * box_size + box_x;
                        let source_y = output_y * box_size + box_y;
                        sum += crop_pixels[(source_y * crop_size + source_x) * 3 + channel] as u32;
                    }
                }
                input[(output_y * REAL_CNN_INPUT_SIZE + output_x) * 3 + channel] =
                    ((sum + (pixels_per_box as u32 / 2)) / pixels_per_box as u32) as u8;
            }
        }
    }

    let mut activations = [0_i32; REAL_CNN_DENSE_FEATURES];
    for filter in 0..REAL_CNN_FILTERS {
        for output_y in 0..REAL_CNN_OUT_SIZE {
            for output_x in 0..REAL_CNN_OUT_SIZE {
                let mut accumulator = REAL_CNN_CONV_BIASES[filter];
                for kernel_y in 0..REAL_CNN_KERNEL {
                    for kernel_x in 0..REAL_CNN_KERNEL {
                        let input_y = output_y * REAL_CNN_STRIDE + kernel_y;
                        let input_x = output_x * REAL_CNN_STRIDE + kernel_x;
                        let input_base = (input_y * REAL_CNN_INPUT_SIZE + input_x) * 3;
                        let weight_base = ((filter * REAL_CNN_KERNEL + kernel_y) * REAL_CNN_KERNEL
                            + kernel_x)
                            * 3;
                        for channel in 0..3 {
                            accumulator += (input[input_base + channel] as i32 - 128)
                                * REAL_CNN_CONV_WEIGHTS[weight_base + channel] as i32;
                        }
                    }
                }
                let feature =
                    (filter * REAL_CNN_OUT_SIZE + output_y) * REAL_CNN_OUT_SIZE + output_x;
                activations[feature] = accumulator.max(0);
            }
        }
    }

    let mut logit = REAL_CNN_DENSE_BIAS;
    for feature in 0..REAL_CNN_DENSE_FEATURES {
        logit += activations[feature] * REAL_CNN_DENSE_WEIGHTS[feature] as i32;
    }
    logit
}

fn stripe_score(crop_pixels: &[u8], crop_size: usize) -> i32 {
    let mut total = 0;
    let mut count = 0;
    let y0 = scale(30, crop_size);
    let y1 = scale(45, crop_size);
    let x0 = scale(20, crop_size);
    let x1 = scale(44, crop_size);
    let stripe_width = scale(4, crop_size).max(1);
    for y in y0..y1 {
        for x in x0..x1 {
            let stripe = ((x - x0) / stripe_width) % 2;
            let expected = if stripe == 0 { RED } else { WHITE };
            total += color_score_at(crop_pixels, crop_size, x, y, expected);
            count += 1;
        }
    }
    rounded_div(total, count)
}

fn region_color_score(
    crop_pixels: &[u8],
    crop_size: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    expected: [u8; 3],
) -> i32 {
    let mut total = 0;
    let mut count = 0;
    for py in y..y + height {
        for px in x..x + width {
            total += color_score_at(crop_pixels, crop_size, px, py, expected);
            count += 1;
        }
    }
    rounded_div(total, count)
}

fn color_score_at(pixels: &[u8], crop_size: usize, x: usize, y: usize, expected: [u8; 3]) -> i32 {
    let offset = (y * crop_size + x) * 3;
    let dr = abs_diff(pixels[offset], expected[0]) as i32;
    let dg = abs_diff(pixels[offset + 1], expected[1]) as i32;
    let db = abs_diff(pixels[offset + 2], expected[2]) as i32;
    0.max(255 - rounded_div(dr + dg + db, 3))
}

fn rounded_div(value: i32, divisor: i32) -> i32 {
    (value + divisor / 2) / divisor
}

fn abs_diff(left: u8, right: u8) -> u8 {
    left.max(right) - left.min(right)
}

fn scale(value: usize, crop_size: usize) -> usize {
    ((value * crop_size) + 32) / 64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_and_preprocessing_hashes_are_wired() {
        assert_eq!(FULL_MODEL_HASH.len(), 32);
        assert_eq!(FULL_PREPROCESSING_HASH.len(), 32);
        assert_eq!(TINY_MODEL_HASH.len(), 32);
        assert_eq!(TINY_PREPROCESSING_HASH.len(), 32);
        assert_eq!(REAL_CNN_MODEL_HASH.len(), 32);
        assert_eq!(REAL_CNN_PREPROCESSING_HASH.len(), 32);
    }
}
