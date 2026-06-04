#![no_main]
#![no_std]

use risc0_zkvm::guest::env;
use zk_waldo_zkvm_core::{
    detector_logit, hash_merkle_node, hash_tile, prove_statement, real_cnn_logit, GuestInput,
    REAL_CNN_MODEL_HASH, REAL_CNN_PREPROCESSING_HASH, REAL_CNN_THRESHOLD, REAL_CROP_SIZE,
    REAL_HEIGHT, REAL_TILE_SIZE, REAL_WIDTH, TINY_CROP_SIZE, TINY_HEIGHT, TINY_MODEL_HASH,
    TINY_PREPROCESSING_HASH, TINY_TILE_SIZE, TINY_WIDTH,
};

risc0_zkvm::guest::entry!(main);

pub fn main() {
    let mut mode = [0_u32; 1];
    env::read_slice(&mut mode);
    if mode[0] == 1 {
        prove_tiny_raw();
    } else if mode[0] == 2 {
        prove_real_raw();
    } else {
        let input: GuestInput = env::read();
        let output = prove_statement(&input);
        env::commit(&output);
    }
}

fn prove_real_raw() {
    let mut image_root = [0_u8; 32];
    let mut threshold = [0_i32; 1];
    let mut tile_meta = [0_u32; 3];
    let mut crop_pixels = [0_u8; (REAL_CROP_SIZE * REAL_CROP_SIZE * 3) as usize];
    let mut merkle_siblings = [0_u8; 256];

    env::read_slice(&mut image_root);
    env::read_slice(&mut threshold);
    env::read_slice(&mut tile_meta);
    env::read_slice(&mut crop_pixels);
    env::read_slice(&mut merkle_siblings);

    assert_eq!(
        threshold[0], REAL_CNN_THRESHOLD,
        "unexpected real CNN threshold"
    );
    let tile_x = tile_meta[0];
    let tile_y = tile_meta[1];
    let leaf_index = tile_meta[2];
    let tile_columns = REAL_WIDTH / REAL_TILE_SIZE;
    assert!(tile_x < tile_columns, "private tile x out of bounds");
    assert!(
        tile_y < REAL_HEIGHT / REAL_TILE_SIZE,
        "private tile y out of bounds"
    );
    assert_eq!(
        leaf_index,
        tile_y * tile_columns + tile_x,
        "private leaf index does not match tile coordinate"
    );

    let mut current = hash_tile(tile_x, tile_y, &crop_pixels);
    let mut index = leaf_index;
    for sibling_index in 0..8 {
        let start = sibling_index * 32;
        let mut sibling = [0_u8; 32];
        sibling.copy_from_slice(&merkle_siblings[start..start + 32]);
        current = if index % 2 == 1 {
            hash_merkle_node(&sibling, &current)
        } else {
            hash_merkle_node(&current, &sibling)
        };
        index /= 2;
    }
    assert_eq!(current, image_root, "invalid private Merkle path");

    let logit = real_cnn_logit(&crop_pixels);
    assert!(logit >= threshold[0], "real CNN logit is below threshold");

    env::commit_slice(&image_root);
    env::commit_slice(&REAL_CNN_MODEL_HASH);
    env::commit_slice(&REAL_CNN_PREPROCESSING_HASH);
    env::commit_slice(&threshold);
    env::commit_slice(&[
        REAL_WIDTH,
        REAL_HEIGHT,
        REAL_CROP_SIZE,
        REAL_CROP_SIZE,
        REAL_TILE_SIZE,
        1,
    ]);
}

fn prove_tiny_raw() {
    let mut image_root = [0_u8; 32];
    let mut threshold = [0_i32; 1];
    let mut tile_meta = [0_u32; 3];
    let mut crop_pixels = [0_u8; (TINY_CROP_SIZE * TINY_CROP_SIZE * 3) as usize];
    let mut merkle_siblings = [0_u8; 64];

    env::read_slice(&mut image_root);
    env::read_slice(&mut threshold);
    env::read_slice(&mut tile_meta);
    env::read_slice(&mut crop_pixels);
    env::read_slice(&mut merkle_siblings);

    let tile_x = tile_meta[0];
    let tile_y = tile_meta[1];
    let leaf_index = tile_meta[2];
    let tile_columns = TINY_WIDTH / TINY_TILE_SIZE;
    assert!(tile_x < tile_columns, "private tile x out of bounds");
    assert!(
        tile_y < TINY_HEIGHT / TINY_TILE_SIZE,
        "private tile y out of bounds"
    );
    assert_eq!(
        leaf_index,
        tile_y * tile_columns + tile_x,
        "private leaf index does not match tile coordinate"
    );

    let mut current = hash_tile(tile_x, tile_y, &crop_pixels);
    let mut index = leaf_index;
    for sibling_index in 0..2 {
        let start = sibling_index * 32;
        let mut sibling = [0_u8; 32];
        sibling.copy_from_slice(&merkle_siblings[start..start + 32]);
        current = if index % 2 == 1 {
            hash_merkle_node(&sibling, &current)
        } else {
            hash_merkle_node(&current, &sibling)
        };
        index /= 2;
    }
    assert_eq!(current, image_root, "invalid private Merkle path");

    let logit = detector_logit(&crop_pixels, TINY_CROP_SIZE);
    assert!(logit >= threshold[0], "classifier logit is below threshold");

    env::commit_slice(&image_root);
    env::commit_slice(&TINY_MODEL_HASH);
    env::commit_slice(&TINY_PREPROCESSING_HASH);
    env::commit_slice(&threshold);
    env::commit_slice(&[
        TINY_WIDTH,
        TINY_HEIGHT,
        TINY_CROP_SIZE,
        TINY_CROP_SIZE,
        TINY_TILE_SIZE,
        1,
    ]);
}
