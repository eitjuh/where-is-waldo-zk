use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use risc0_zkvm::{default_prover, ExecutorEnv, ExecutorImpl, Receipt};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Instant,
};
use zk_waldo_methods::{ZK_WALDO_GUEST_ELF, ZK_WALDO_GUEST_ID};
use zk_waldo_zkvm_core::{
    detector_logit, hash_merkle_node, hash_tile, real_cnn_logit, Direction, GuestInput, MerkleStep,
    PrivateWitness, PublicInputs, PublicOutput, TileWitness, FULL_MODEL_HASH,
    FULL_PREPROCESSING_HASH, REAL_CNN_MODEL_HASH, REAL_CNN_PREPROCESSING_HASH, REAL_CNN_THRESHOLD,
    REAL_CROP_SIZE, REAL_HEIGHT, REAL_TILE_SIZE, REAL_WIDTH, TINY_CROP_SIZE, TINY_HEIGHT,
    TINY_MODEL_HASH, TINY_PREPROCESSING_HASH, TINY_TILE_SIZE, TINY_WIDTH,
};

fn main() -> Result<()> {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args[0] == "help" || args[0] == "--help" {
        print_help();
        return Ok(());
    }

    let command = args.remove(0);
    let flags = Flags::parse(args)?;
    match command.as_str() {
        "prove" => prove_command(&flags),
        "verify" => verify_command(&flags),
        "prove-tiny" => prove_tiny_command(&flags),
        "verify-tiny" => verify_tiny_command(&flags),
        "exec-tiny" => exec_tiny_command(&flags),
        "prove-real" => prove_real_command(&flags),
        "verify-real" => verify_real_command(&flags),
        "exec-real" => exec_real_command(&flags),
        other => bail!("unknown command: {other}"),
    }
}

fn prove_real_command(flags: &Flags) -> Result<()> {
    let commitment_path = flags.required("commitment")?;
    let witness_path = flags.required("witness")?;
    let receipt_path = flags.required("receipt")?;
    let input = real_raw_input_from_files(commitment_path, witness_path)?;
    prove_real_raw_input(input, receipt_path)
}

fn verify_real_command(flags: &Flags) -> Result<()> {
    let commitment_path = flags.required("commitment")?;
    let receipt_path = flags.required("receipt")?;
    let commitment = read_commitment(commitment_path)?;
    let public_inputs = public_inputs_from_real_commitment(&commitment)?;
    verify_real_raw_receipt(receipt_path, &public_inputs)
}

fn exec_real_command(flags: &Flags) -> Result<()> {
    let commitment_path = flags.required("commitment")?;
    let witness_path = flags.required("witness")?;
    let input = real_raw_input_from_files(commitment_path, witness_path)?;
    let env = build_real_raw_env(&input)?;
    let mut exec = ExecutorImpl::from_elf(env, ZK_WALDO_GUEST_ELF)?;
    let session = exec.run()?;
    println!("segments: {}", session.segments.len());
    println!("user_cycles: {}", session.user_cycles);
    println!("total_cycles: {}", session.total_cycles);
    println!("real_cnn_logit: {}", input.logit);
    Ok(())
}

fn prove_command(flags: &Flags) -> Result<()> {
    let commitment_path = flags.required("commitment")?;
    let witness_path = flags.required("witness")?;
    let receipt_path = flags.required("receipt")?;
    let threshold = flags
        .optional("threshold")
        .map(|value| value.parse::<i32>())
        .transpose()?
        .unwrap_or(700);

    let commitment = read_commitment(commitment_path)?;
    let witness_json = read_witness_json(witness_path)?;
    let public_inputs = public_inputs_from_commitment(&commitment, threshold)?;
    let witness = private_witness_from_json(witness_json)?;
    let input = GuestInput {
        public_inputs: public_inputs.clone(),
        witness,
    };

    prove_input(input, &public_inputs, receipt_path)
}

fn verify_command(flags: &Flags) -> Result<()> {
    let commitment_path = flags.required("commitment")?;
    let receipt_path = flags.required("receipt")?;
    let threshold = flags
        .optional("threshold")
        .map(|value| value.parse::<i32>())
        .transpose()?
        .unwrap_or(700);

    let commitment = read_commitment(commitment_path)?;
    let expected_public_inputs = public_inputs_from_commitment(&commitment, threshold)?;
    verify_receipt(receipt_path, &expected_public_inputs, threshold)
}

fn prove_tiny_command(flags: &Flags) -> Result<()> {
    let receipt_path = flags
        .optional_path("receipt")
        .unwrap_or_else(|| Path::new("proofs/end_to_end_tiny.risc0.json"));
    let threshold = flags
        .optional("threshold")
        .map(|value| value.parse::<i32>())
        .transpose()?
        .unwrap_or(700);

    let input = tiny_raw_fixture(threshold)?;
    prove_tiny_raw_input(input, receipt_path)
}

fn verify_tiny_command(flags: &Flags) -> Result<()> {
    let receipt_path = flags
        .optional_path("receipt")
        .unwrap_or_else(|| Path::new("proofs/end_to_end_tiny.risc0.json"));
    let threshold = flags
        .optional("threshold")
        .map(|value| value.parse::<i32>())
        .transpose()?
        .unwrap_or(700);

    let expected_public_inputs = tiny_raw_fixture(threshold)?.public_inputs;
    verify_tiny_raw_receipt(receipt_path, &expected_public_inputs, threshold)
}

fn exec_tiny_command(flags: &Flags) -> Result<()> {
    let threshold = flags
        .optional("threshold")
        .map(|value| value.parse::<i32>())
        .transpose()?
        .unwrap_or(700);
    let input = tiny_raw_fixture(threshold)?;
    let env = build_tiny_raw_env(&input)?;
    let mut exec = ExecutorImpl::from_elf(env, ZK_WALDO_GUEST_ELF)?;
    let session = exec.run()?;
    println!("segments: {}", session.segments.len());
    println!("user_cycles: {}", session.user_cycles);
    println!("total_cycles: {}", session.total_cycles);
    Ok(())
}

fn prove_input(input: GuestInput, public_inputs: &PublicInputs, receipt_path: &Path) -> Result<()> {
    let mut builder = ExecutorEnv::builder();
    builder.write_slice(&[0_u32]);
    builder
        .write(&input)
        .context("serializing zkVM guest input")?;
    let env = builder
        .build()
        .context("building zkVM executor environment")?;

    let started = Instant::now();
    let proving = Arc::new(AtomicBool::new(true));
    let heartbeat_flag = Arc::clone(&proving);
    let heartbeat = thread::spawn(move || {
        while heartbeat_flag.load(Ordering::Relaxed) {
            eprintln!("proving RISC Zero receipt...");
            thread::sleep(std::time::Duration::from_secs(20));
        }
    });
    let receipt_result = default_prover()
        .prove(env, ZK_WALDO_GUEST_ELF)
        .context("proving zkVM guest execution");
    proving.store(false, Ordering::Relaxed);
    let _ = heartbeat.join();
    let receipt = receipt_result?.receipt;
    let prove_ms = started.elapsed().as_millis();

    receipt
        .verify(ZK_WALDO_GUEST_ID)
        .context("verifying freshly generated receipt")?;
    let output: PublicOutput = receipt
        .journal
        .decode()
        .context("decoding zkVM receipt journal")?;
    if output.public_inputs != *public_inputs || !output.accepted {
        bail!("guest journal does not match expected public statement");
    }

    let encoded = StoredReceipt {
        schema: "zk-waldo-risc0-receipt-v0".to_owned(),
        backend: "risc0-zkvm-3.0.5".to_owned(),
        image_id: ZK_WALDO_GUEST_ID,
        public_output: output,
        prove_ms,
        receipt_bincode_base64: BASE64.encode(bincode::serialize(&receipt)?),
    };
    write_json(receipt_path, &encoded)?;

    println!("RISC Zero proof generated.");
    println!("receipt: {}", receipt_path.display());
    println!("prove_ms: {prove_ms}");
    println!("location: hidden");
    println!("crop: hidden");
    Ok(())
}

fn prove_tiny_raw_input(input: TinyRawInput, receipt_path: &Path) -> Result<()> {
    let env = build_tiny_raw_env(&input)?;

    let started = Instant::now();
    let proving = Arc::new(AtomicBool::new(true));
    let heartbeat_flag = Arc::clone(&proving);
    let heartbeat = thread::spawn(move || {
        while heartbeat_flag.load(Ordering::Relaxed) {
            eprintln!("proving RISC Zero receipt...");
            thread::sleep(std::time::Duration::from_secs(20));
        }
    });
    let receipt_result = default_prover()
        .prove(env, ZK_WALDO_GUEST_ELF)
        .context("proving compact zkVM guest execution");
    proving.store(false, Ordering::Relaxed);
    let _ = heartbeat.join();
    let receipt = receipt_result?.receipt;
    let prove_ms = started.elapsed().as_millis();

    receipt
        .verify(ZK_WALDO_GUEST_ID)
        .context("verifying freshly generated receipt")?;
    let output = PublicOutput {
        public_inputs: input.public_inputs.clone(),
        accepted: true,
    };
    let expected_journal = expected_raw_journal(&input.public_inputs);
    if receipt.journal.bytes != expected_journal {
        bail!("guest journal does not match expected compact public statement");
    }

    let encoded = StoredReceipt {
        schema: "zk-waldo-risc0-raw-tiny-receipt-v0".to_owned(),
        backend: "risc0-zkvm-3.0.5".to_owned(),
        image_id: ZK_WALDO_GUEST_ID,
        public_output: output,
        prove_ms,
        receipt_bincode_base64: BASE64.encode(bincode::serialize(&receipt)?),
    };
    write_json(receipt_path, &encoded)?;

    println!("RISC Zero proof generated.");
    println!("receipt: {}", receipt_path.display());
    println!("prove_ms: {prove_ms}");
    println!("location: hidden");
    println!("crop: hidden");
    Ok(())
}

fn prove_real_raw_input(input: RealRawInput, receipt_path: &Path) -> Result<()> {
    let env = build_real_raw_env(&input)?;

    let started = Instant::now();
    let proving = Arc::new(AtomicBool::new(true));
    let heartbeat_flag = Arc::clone(&proving);
    let heartbeat = thread::spawn(move || {
        while heartbeat_flag.load(Ordering::Relaxed) {
            eprintln!("proving real-image RISC Zero receipt...");
            thread::sleep(std::time::Duration::from_secs(20));
        }
    });
    let receipt_result = default_prover()
        .prove(env, ZK_WALDO_GUEST_ELF)
        .context("proving real-image zkVM guest execution");
    proving.store(false, Ordering::Relaxed);
    let _ = heartbeat.join();
    let receipt = receipt_result?.receipt;
    let prove_ms = started.elapsed().as_millis();

    receipt
        .verify(ZK_WALDO_GUEST_ID)
        .context("verifying freshly generated real-image receipt")?;
    let output = PublicOutput {
        public_inputs: input.public_inputs.clone(),
        accepted: true,
    };
    if receipt.journal.bytes != expected_raw_journal(&input.public_inputs) {
        bail!("guest journal does not match expected real-image public statement");
    }

    let encoded = StoredReceipt {
        schema: "zk-waldo-risc0-real-cnn-receipt-v1".to_owned(),
        backend: "risc0-zkvm-3.0.5-real-cnn".to_owned(),
        image_id: ZK_WALDO_GUEST_ID,
        public_output: output,
        prove_ms,
        receipt_bincode_base64: BASE64.encode(bincode::serialize(&receipt)?),
    };
    write_json(receipt_path, &encoded)?;

    println!("Real-image RISC Zero proof generated.");
    println!("receipt: {}", receipt_path.display());
    println!("prove_ms: {prove_ms}");
    println!("private CNN logit: {}", input.logit);
    println!("location: hidden");
    println!("crop: hidden");
    Ok(())
}

fn verify_receipt(
    receipt_path: &Path,
    expected_public_inputs: &PublicInputs,
    threshold: i32,
) -> Result<()> {
    let stored: StoredReceipt = read_json(receipt_path)?;

    if stored.image_id != ZK_WALDO_GUEST_ID {
        bail!("receipt image ID does not match this verifier");
    }

    let receipt_bytes = BASE64
        .decode(stored.receipt_bincode_base64)
        .context("decoding base64 RISC Zero receipt")?;
    let receipt: Receipt =
        bincode::deserialize(&receipt_bytes).context("decoding RISC Zero receipt")?;
    receipt
        .verify(ZK_WALDO_GUEST_ID)
        .context("RISC Zero receipt verification failed")?;
    let output: PublicOutput = receipt
        .journal
        .decode()
        .context("decoding zkVM receipt journal")?;

    if output.public_inputs != *expected_public_inputs || !output.accepted {
        bail!("receipt journal does not match expected public inputs");
    }

    println!("RISC Zero proof valid.");
    println!(
        "Statement: prover knows a private crop from image_root that passes model_hash at threshold {threshold}."
    );
    println!("Location: hidden.");
    println!("Crop: hidden.");
    Ok(())
}

fn verify_tiny_raw_receipt(
    receipt_path: &Path,
    expected_public_inputs: &PublicInputs,
    threshold: i32,
) -> Result<()> {
    let stored: StoredReceipt = read_json(receipt_path)?;

    if stored.image_id != ZK_WALDO_GUEST_ID {
        bail!("receipt image ID does not match this verifier");
    }

    let receipt_bytes = BASE64
        .decode(stored.receipt_bincode_base64)
        .context("decoding base64 RISC Zero receipt")?;
    let receipt: Receipt =
        bincode::deserialize(&receipt_bytes).context("decoding RISC Zero receipt")?;
    receipt
        .verify(ZK_WALDO_GUEST_ID)
        .context("RISC Zero receipt verification failed")?;

    let expected_output = PublicOutput {
        public_inputs: expected_public_inputs.clone(),
        accepted: true,
    };
    if stored.public_output != expected_output {
        bail!("stored public output metadata does not match expected public inputs");
    }
    if receipt.journal.bytes != expected_raw_journal(expected_public_inputs) {
        bail!("receipt journal does not match expected compact public inputs");
    }

    println!("RISC Zero proof valid.");
    println!(
        "Statement: prover knows a private crop from image_root that passes model_hash at threshold {threshold}."
    );
    println!("Location: hidden.");
    println!("Crop: hidden.");
    Ok(())
}

fn verify_real_raw_receipt(
    receipt_path: &Path,
    expected_public_inputs: &PublicInputs,
) -> Result<()> {
    let stored: StoredReceipt = read_json(receipt_path)?;
    if stored.schema != "zk-waldo-risc0-real-cnn-receipt-v1"
        || stored.backend != "risc0-zkvm-3.0.5-real-cnn"
    {
        bail!("unexpected real-image receipt wrapper");
    }
    if stored.image_id != ZK_WALDO_GUEST_ID {
        bail!("receipt image ID does not match this verifier");
    }

    let receipt_bytes = BASE64
        .decode(stored.receipt_bincode_base64)
        .context("decoding base64 real-image RISC Zero receipt")?;
    let receipt: Receipt =
        bincode::deserialize(&receipt_bytes).context("decoding real-image RISC Zero receipt")?;
    receipt
        .verify(ZK_WALDO_GUEST_ID)
        .context("real-image RISC Zero receipt verification failed")?;

    let expected_output = PublicOutput {
        public_inputs: expected_public_inputs.clone(),
        accepted: true,
    };
    if stored.public_output != expected_output {
        bail!("stored public output metadata does not match the real-image public inputs");
    }
    if receipt.journal.bytes != expected_raw_journal(expected_public_inputs) {
        bail!("receipt journal does not match the expected real-image public inputs");
    }

    println!("Real-image RISC Zero proof valid.");
    println!(
        "Statement: prover knows a private 64x64 crop from the committed real puzzle image that passes the trained quantized CNN at threshold {}.",
        expected_public_inputs.threshold_logit
    );
    println!("Location: hidden.");
    println!("Crop: hidden.");
    Ok(())
}

#[derive(Debug, Deserialize)]
struct CommitmentJson {
    image_root: String,
    preprocessing_hash: String,
    image_width: u32,
    image_height: u32,
    crop_width: u32,
    crop_height: u32,
    tile_size: u32,
}

#[derive(Debug, Deserialize)]
struct WitnessJson {
    x: u32,
    y: u32,
    crop_width: u32,
    crop_height: u32,
    crop_pixels: String,
    tiles: Vec<TileWitnessJson>,
}

#[derive(Debug, Deserialize)]
struct TileWitnessJson {
    tile_x: u32,
    tile_y: u32,
    leaf_index: u32,
    pixels: String,
    merkle_path: Vec<MerkleStepJson>,
}

#[derive(Debug, Deserialize)]
struct MerkleStepJson {
    sibling: String,
    direction: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredReceipt {
    schema: String,
    backend: String,
    image_id: [u32; 8],
    public_output: PublicOutput,
    prove_ms: u128,
    receipt_bincode_base64: String,
}

fn public_inputs_from_commitment(
    commitment: &CommitmentJson,
    threshold_logit: i32,
) -> Result<PublicInputs> {
    let image_root = hex32(&commitment.image_root)?;
    let preprocessing_hash = hex32(&commitment.preprocessing_hash)?;
    if preprocessing_hash != FULL_PREPROCESSING_HASH {
        bail!("commitment preprocessing hash does not match zkVM guest");
    }

    Ok(PublicInputs {
        image_root,
        model_hash: FULL_MODEL_HASH,
        preprocessing_hash,
        threshold_logit,
        image_width: commitment.image_width,
        image_height: commitment.image_height,
        crop_width: commitment.crop_width,
        crop_height: commitment.crop_height,
        tile_size: commitment.tile_size,
    })
}

fn public_inputs_from_real_commitment(commitment: &CommitmentJson) -> Result<PublicInputs> {
    let image_root = hex32(&commitment.image_root)?;
    let preprocessing_hash = hex32(&commitment.preprocessing_hash)?;
    if preprocessing_hash != REAL_CNN_PREPROCESSING_HASH {
        bail!("commitment preprocessing hash does not match the trained real CNN guest");
    }
    if commitment.image_width != REAL_WIDTH
        || commitment.image_height != REAL_HEIGHT
        || commitment.crop_width != REAL_CROP_SIZE
        || commitment.crop_height != REAL_CROP_SIZE
        || commitment.tile_size != REAL_TILE_SIZE
    {
        bail!("commitment dimensions do not match the real-image proof profile");
    }

    Ok(PublicInputs {
        image_root,
        model_hash: REAL_CNN_MODEL_HASH,
        preprocessing_hash,
        threshold_logit: REAL_CNN_THRESHOLD,
        image_width: commitment.image_width,
        image_height: commitment.image_height,
        crop_width: commitment.crop_width,
        crop_height: commitment.crop_height,
        tile_size: commitment.tile_size,
    })
}

fn private_witness_from_json(json: WitnessJson) -> Result<PrivateWitness> {
    Ok(PrivateWitness {
        x: json.x,
        y: json.y,
        crop_width: json.crop_width,
        crop_height: json.crop_height,
        crop_pixels: hex_vec(&json.crop_pixels)?,
        tiles: json
            .tiles
            .into_iter()
            .map(|tile| {
                Ok(TileWitness {
                    tile_x: tile.tile_x,
                    tile_y: tile.tile_y,
                    leaf_index: tile.leaf_index,
                    pixels: hex_vec(&tile.pixels)?,
                    merkle_path: tile
                        .merkle_path
                        .into_iter()
                        .map(|step| {
                            Ok(MerkleStep {
                                sibling: hex32(&step.sibling)?,
                                direction: match step.direction.as_str() {
                                    "left" => Direction::Left,
                                    "right" => Direction::Right,
                                    other => bail!("invalid Merkle direction: {other}"),
                                },
                            })
                        })
                        .collect::<Result<Vec<_>>>()?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    })
}

#[derive(Clone)]
struct RealRawInput {
    public_inputs: PublicInputs,
    tile_x: u32,
    tile_y: u32,
    leaf_index: u32,
    crop_pixels: Vec<u8>,
    merkle_siblings: [[u8; 32]; 8],
    logit: i32,
}

fn real_raw_input_from_files(commitment_path: &Path, witness_path: &Path) -> Result<RealRawInput> {
    let commitment = read_commitment(commitment_path)?;
    let public_inputs = public_inputs_from_real_commitment(&commitment)?;
    let witness = read_witness_json(witness_path)?;
    if witness.crop_width != REAL_CROP_SIZE || witness.crop_height != REAL_CROP_SIZE {
        bail!("private witness crop dimensions do not match the real-image proof profile");
    }
    if witness.x % REAL_TILE_SIZE != 0 || witness.y % REAL_TILE_SIZE != 0 {
        bail!("private real-image crop must be tile aligned");
    }
    if witness.x + REAL_CROP_SIZE > REAL_WIDTH || witness.y + REAL_CROP_SIZE > REAL_HEIGHT {
        bail!("private real-image crop is out of bounds");
    }
    if witness.tiles.len() != 1 {
        bail!("real-image proof profile requires exactly one private tile");
    }

    let crop_pixels = hex_vec(&witness.crop_pixels)?;
    let tile = witness.tiles.into_iter().next().unwrap();
    let tile_pixels = hex_vec(&tile.pixels)?;
    if crop_pixels != tile_pixels {
        bail!("private crop pixels do not match the one-tile witness");
    }
    let expected_tile_x = witness.x / REAL_TILE_SIZE;
    let expected_tile_y = witness.y / REAL_TILE_SIZE;
    let expected_leaf_index = expected_tile_y * (REAL_WIDTH / REAL_TILE_SIZE) + expected_tile_x;
    if tile.tile_x != expected_tile_x
        || tile.tile_y != expected_tile_y
        || tile.leaf_index != expected_leaf_index
    {
        bail!("private tile metadata does not match private crop coordinates");
    }
    if tile.merkle_path.len() != 8 {
        bail!("real-image proof profile requires an eight-step private Merkle path");
    }
    let siblings = tile
        .merkle_path
        .into_iter()
        .map(|step| hex32(&step.sibling))
        .collect::<Result<Vec<_>>>()?;
    let merkle_siblings: [[u8; 32]; 8] = siblings
        .try_into()
        .map_err(|_| anyhow!("failed to build fixed real-image Merkle path"))?;
    let logit = real_cnn_logit(&crop_pixels);
    if logit < REAL_CNN_THRESHOLD {
        bail!(
            "trained real CNN logit {logit} is below threshold {}",
            REAL_CNN_THRESHOLD
        );
    }

    Ok(RealRawInput {
        public_inputs,
        tile_x: tile.tile_x,
        tile_y: tile.tile_y,
        leaf_index: tile.leaf_index,
        crop_pixels,
        merkle_siblings,
        logit,
    })
}

fn build_real_raw_env(input: &RealRawInput) -> Result<ExecutorEnv<'static>> {
    let mut siblings = [0_u8; 256];
    for (index, sibling) in input.merkle_siblings.iter().enumerate() {
        siblings[index * 32..(index + 1) * 32].copy_from_slice(sibling);
    }

    let mut builder = ExecutorEnv::builder();
    builder.write_slice(&[2_u32]);
    builder.write_slice(&input.public_inputs.image_root);
    builder.write_slice(&[input.public_inputs.threshold_logit]);
    builder.write_slice(&[input.tile_x, input.tile_y, input.leaf_index]);
    builder.write_slice(&input.crop_pixels);
    builder.write_slice(&siblings);
    builder
        .build()
        .context("building real-image zkVM executor environment")
}

#[derive(Clone)]
struct TinyRawInput {
    public_inputs: PublicInputs,
    tile_x: u32,
    tile_y: u32,
    leaf_index: u32,
    crop_pixels: Vec<u8>,
    merkle_siblings: [[u8; 32]; 2],
}

fn build_tiny_raw_env(input: &TinyRawInput) -> Result<ExecutorEnv<'static>> {
    let mut siblings = [0_u8; 64];
    siblings[0..32].copy_from_slice(&input.merkle_siblings[0]);
    siblings[32..64].copy_from_slice(&input.merkle_siblings[1]);

    let mut builder = ExecutorEnv::builder();
    builder.write_slice(&[1_u32]);
    builder.write_slice(&input.public_inputs.image_root);
    builder.write_slice(&[input.public_inputs.threshold_logit]);
    builder.write_slice(&[input.tile_x, input.tile_y, input.leaf_index]);
    builder.write_slice(&input.crop_pixels);
    builder.write_slice(&siblings);
    builder
        .build()
        .context("building compact zkVM executor environment")
}

fn expected_raw_journal(public_inputs: &PublicInputs) -> Vec<u8> {
    let mut journal = Vec::with_capacity(124);
    journal.extend_from_slice(&public_inputs.image_root);
    journal.extend_from_slice(&public_inputs.model_hash);
    journal.extend_from_slice(&public_inputs.preprocessing_hash);
    journal.extend_from_slice(&public_inputs.threshold_logit.to_le_bytes());
    for value in [
        public_inputs.image_width,
        public_inputs.image_height,
        public_inputs.crop_width,
        public_inputs.crop_height,
        public_inputs.tile_size,
        1,
    ] {
        journal.extend_from_slice(&value.to_le_bytes());
    }
    journal
}

fn tiny_raw_fixture(threshold_logit: i32) -> Result<TinyRawInput> {
    let mut pixels = vec![0_u8; (TINY_WIDTH * TINY_HEIGHT * 3) as usize];
    fill_rect(
        &mut pixels,
        TINY_WIDTH,
        0,
        0,
        TINY_WIDTH,
        TINY_HEIGHT,
        [242, 238, 220],
    );
    draw_tiny_target(&mut pixels, TINY_WIDTH, 16, 16);

    let tiles = split_tiny_tiles(&pixels);
    let leaves = tiles
        .iter()
        .map(|tile| hash_tile(tile.tile_x, tile.tile_y, &tile.pixels))
        .collect::<Vec<_>>();
    let tree = build_tiny_tree(leaves);
    let image_root = tree.last().unwrap()[0];

    let tile_x = 16 / TINY_TILE_SIZE;
    let tile_y = 16 / TINY_TILE_SIZE;
    let leaf_index = tile_y * (TINY_WIDTH / TINY_TILE_SIZE) + tile_x;
    let crop_pixels = extract_crop(&pixels, TINY_WIDTH, 16, 16, TINY_CROP_SIZE);
    let logit = detector_logit(&crop_pixels, TINY_CROP_SIZE);
    if logit < threshold_logit {
        bail!("tiny fixture logit {logit} is below threshold {threshold_logit}");
    }
    let merkle_path = tiny_merkle_path(&tree, leaf_index as usize);
    if merkle_path.len() != 2 {
        bail!("compact tiny fixture expected a two-step Merkle path");
    }

    Ok(TinyRawInput {
        public_inputs: PublicInputs {
            image_root,
            model_hash: TINY_MODEL_HASH,
            preprocessing_hash: TINY_PREPROCESSING_HASH,
            threshold_logit,
            image_width: TINY_WIDTH,
            image_height: TINY_HEIGHT,
            crop_width: TINY_CROP_SIZE,
            crop_height: TINY_CROP_SIZE,
            tile_size: TINY_TILE_SIZE,
        },
        tile_x,
        tile_y,
        leaf_index,
        crop_pixels,
        merkle_siblings: [merkle_path[0].sibling, merkle_path[1].sibling],
    })
}

#[derive(Clone)]
struct TinyTile {
    tile_x: u32,
    tile_y: u32,
    pixels: Vec<u8>,
}

fn split_tiny_tiles(pixels: &[u8]) -> Vec<TinyTile> {
    let tile_columns = TINY_WIDTH / TINY_TILE_SIZE;
    let mut tiles = Vec::new();
    for tile_y in 0..tile_columns {
        for tile_x in 0..tile_columns {
            let mut tile_pixels = vec![0_u8; (TINY_TILE_SIZE * TINY_TILE_SIZE * 3) as usize];
            for row in 0..TINY_TILE_SIZE {
                let src_start = (((tile_y * TINY_TILE_SIZE + row) * TINY_WIDTH
                    + tile_x * TINY_TILE_SIZE)
                    * 3) as usize;
                let src_end = src_start + (TINY_TILE_SIZE * 3) as usize;
                let dst_start = (row * TINY_TILE_SIZE * 3) as usize;
                tile_pixels[dst_start..dst_start + (TINY_TILE_SIZE * 3) as usize]
                    .copy_from_slice(&pixels[src_start..src_end]);
            }
            tiles.push(TinyTile {
                tile_x,
                tile_y,
                pixels: tile_pixels,
            });
        }
    }
    tiles
}

fn build_tiny_tree(leaves: Vec<[u8; 32]>) -> Vec<Vec<[u8; 32]>> {
    let mut levels = vec![leaves];
    while levels.last().unwrap().len() > 1 {
        let current = levels.last().unwrap();
        let mut next = Vec::new();
        for index in (0..current.len()).step_by(2) {
            let left = current[index];
            let right = current.get(index + 1).copied().unwrap_or(left);
            next.push(hash_merkle_node(&left, &right));
        }
        levels.push(next);
    }
    levels
}

fn tiny_merkle_path(tree: &[Vec<[u8; 32]>], leaf_index: usize) -> Vec<MerkleStep> {
    let mut path = Vec::new();
    let mut index = leaf_index;
    for level in tree.iter().take(tree.len() - 1) {
        let is_right = index % 2 == 1;
        let sibling_index = if is_right { index - 1 } else { index + 1 };
        let sibling = level.get(sibling_index).copied().unwrap_or(level[index]);
        path.push(MerkleStep {
            sibling,
            direction: if is_right {
                Direction::Left
            } else {
                Direction::Right
            },
        });
        index /= 2;
    }
    path
}

fn extract_crop(pixels: &[u8], image_width: u32, x: u32, y: u32, crop_size: u32) -> Vec<u8> {
    let mut crop = vec![0_u8; (crop_size * crop_size * 3) as usize];
    for row in 0..crop_size {
        let src_start = (((y + row) * image_width + x) * 3) as usize;
        let src_end = src_start + (crop_size * 3) as usize;
        let dst_start = (row * crop_size * 3) as usize;
        crop[dst_start..dst_start + (crop_size * 3) as usize]
            .copy_from_slice(&pixels[src_start..src_end]);
    }
    crop
}

fn draw_tiny_target(pixels: &mut [u8], width: u32, crop_x: u32, crop_y: u32) {
    fill_rect(pixels, width, crop_x + 6, crop_y + 2, 5, 2, [206, 34, 46]);
    fill_rect(pixels, width, crop_x + 5, crop_y + 3, 7, 1, [206, 34, 46]);
    fill_rect(
        pixels,
        width,
        crop_x + 11,
        crop_y + 1,
        1,
        1,
        [248, 246, 235],
    );

    fill_rect(pixels, width, crop_x + 6, crop_y + 4, 4, 4, [238, 183, 132]);
    fill_rect(pixels, width, crop_x + 6, crop_y + 5, 5, 1, [30, 34, 40]);
    fill_rect(pixels, width, crop_x + 7, crop_y + 5, 1, 1, [30, 34, 40]);
    fill_rect(pixels, width, crop_x + 9, crop_y + 5, 1, 1, [30, 34, 40]);

    for stripe in 0..6 {
        let color = if stripe % 2 == 0 {
            [206, 34, 46]
        } else {
            [248, 246, 235]
        };
        fill_rect(pixels, width, crop_x + 5 + stripe, crop_y + 8, 1, 3, color);
    }
    fill_rect(pixels, width, crop_x + 4, crop_y + 8, 1, 3, [206, 34, 46]);
    fill_rect(pixels, width, crop_x + 12, crop_y + 8, 1, 3, [206, 34, 46]);

    fill_rect(pixels, width, crop_x + 6, crop_y + 11, 3, 4, [42, 89, 176]);
    fill_rect(pixels, width, crop_x + 9, crop_y + 11, 3, 4, [42, 89, 176]);
    fill_rect(pixels, width, crop_x + 5, crop_y + 15, 4, 1, [30, 34, 40]);
    fill_rect(pixels, width, crop_x + 9, crop_y + 15, 4, 1, [30, 34, 40]);
}

fn fill_rect(
    pixels: &mut [u8],
    image_width: u32,
    x: u32,
    y: u32,
    rect_width: u32,
    rect_height: u32,
    color: [u8; 3],
) {
    for py in y..y + rect_height {
        for px in x..x + rect_width {
            let offset = ((py * image_width + px) * 3) as usize;
            pixels[offset] = color[0];
            pixels[offset + 1] = color[1];
            pixels[offset + 2] = color[2];
        }
    }
}

fn read_commitment(path: &Path) -> Result<CommitmentJson> {
    read_json(path).with_context(|| format!("reading commitment {}", path.display()))
}

fn read_witness_json(path: &Path) -> Result<WitnessJson> {
    read_json(path).with_context(|| format!("reading private witness {}", path.display()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn hex32(value: &str) -> Result<[u8; 32]> {
    let bytes = hex_vec(value)?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| anyhow!("expected 32 bytes, got {}", bytes.len()))
}

fn hex_vec(value: &str) -> Result<Vec<u8>> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    if clean.len() % 2 != 0 {
        bail!("hex string has odd length");
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    for index in (0..clean.len()).step_by(2) {
        out.push(u8::from_str_radix(&clean[index..index + 2], 16)?);
    }
    Ok(out)
}

#[derive(Default)]
struct Flags(Vec<(String, PathBuf)>);

impl Flags {
    fn parse(args: Vec<String>) -> Result<Self> {
        let mut parsed = Vec::new();
        let mut iter = args.into_iter();
        while let Some(flag) = iter.next() {
            let key = flag
                .strip_prefix("--")
                .ok_or_else(|| anyhow!("expected --flag, got {flag}"))?
                .replace('-', "_");
            let value = iter
                .next()
                .ok_or_else(|| anyhow!("missing value for --{key}"))?;
            parsed.push((key, PathBuf::from(value)));
        }
        Ok(Self(parsed))
    }

    fn required(&self, key: &str) -> Result<&Path> {
        self.0
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value.as_path())
            .ok_or_else(|| anyhow!("missing --{}", key.replace('_', "-")))
    }

    fn optional(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(candidate, _)| candidate == key)
            .and_then(|(_, value)| value.to_str())
    }

    fn optional_path(&self, key: &str) -> Option<&Path> {
        self.0
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value.as_path())
    }
}

fn print_help() {
    println!(
        "zk-waldo-zkvm-host

Usage:
  cargo run -p zk-waldo-zkvm-host -- prove --commitment demo/commitment.json --witness demo/witness.private.json --receipt proofs/end_to_end_valid.risc0.json
  cargo run -p zk-waldo-zkvm-host -- verify --commitment demo/commitment.json --receipt proofs/end_to_end_valid.risc0.json
  cargo run -p zk-waldo-zkvm-host -- prove-tiny --receipt proofs/end_to_end_tiny.risc0.json
  cargo run -p zk-waldo-zkvm-host -- verify-tiny --receipt proofs/end_to_end_tiny.risc0.json
  cargo run -p zk-waldo-zkvm-host -- exec-real --commitment demo/real/puzzles/crowded-beach/commitment.json --witness demo/real/puzzles/crowded-beach/witness.private.json
  cargo run -p zk-waldo-zkvm-host -- prove-real --commitment demo/real/puzzles/crowded-beach/commitment.json --witness demo/real/puzzles/crowded-beach/witness.private.json --receipt proofs/end_to_end_real.risc0.json
  cargo run -p zk-waldo-zkvm-host -- verify-real --commitment demo/real/puzzles/crowded-beach/commitment.json --receipt proofs/end_to_end_real.risc0.json
"
    );
}
