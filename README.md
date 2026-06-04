# zk-waldo

`zk-waldo` is a working zero-knowledge Where's Waldo demo:

> A prover knows a private `64x64` crop from a committed real puzzle image that
> passes an agreed trained CNN, without revealing the crop or its coordinates.

The main demo includes six actual puzzle pages, a trained and quantized
convolutional neural network, a separate tiled SHA-256 Merkle commitment for
each page, and real RISC Zero receipts. The RISC Zero guest verifies crop
inclusion and runs integer CNN inference before committing only the public
statement to its journal.

## Run The Split-Screen Demo

Prerequisites are Node.js 20+, pnpm, Rust, and the RISC Zero `r0vm` component.

```bash
pnpm real:prepare
pnpm real:serve
```

Open:

```text
http://127.0.0.1:4174/
```

Choose any of the six pages on the Prover side, then click Waldo. A passing
click generates a real RISC Zero proof in about 20 seconds on the development
machine. Copy, download, or send the proof to the Verifier side, which
automatically identifies the committed page from the proof's public image root.

The demo server is a local prover process. If it is hosted remotely, that
server sees the clicked coordinates. A production deployment should run the
prover locally or in a trusted prover environment.

## Real Proof Commands

```bash
pnpm real:prepare
pnpm real:exec
pnpm real:prove
pnpm real:verify
```

The generated receipt is:

```text
proofs/end_to_end_real.risc0.json
```

Verified local benchmark:

```text
real CNN guest cycles: ~181,050
total zkVM cycles:     262,144
proof generation:      20.005 s
proof JSON size:        343,448 bytes
```

## Trained CNN

The real-image model is `waldo_real_tiny_cnn_v1`:

```text
private input: 64x64 RGB crop
preprocessing: deterministic 4x4 box average to 16x16 RGB
network: Conv2D(3 -> 12, 3x3, stride 2) -> ReLU -> Flatten -> Dense(588 -> 1)
parameters: 925
weights: int8
accumulators and logit: int32
threshold: 2,823,294
```

Each catalog page has exactly one accepted aligned tile. The published
evaluation metrics are prototype metrics, not a production accuracy claim; see
[`reports/model_eval.md`](./reports/model_eval.md).

Retraining expects a local Hey-Waldo checkout:

```bash
git clone https://github.com/vc1492a/Hey-Waldo.git /tmp/hey-waldo
pnpm real:train
pnpm real:prepare
```

The Hey-Waldo repository labels the dataset ODbL 1.0. The underlying Where's
Waldo artwork remains third-party copyrighted material; verify distribution
rights before publishing the included demo asset.

## What Is Public And Private

Public receipt inputs:

```text
image_root
model_hash
preprocessing_hash
threshold_logit
fixed image, crop, and tile dimensions
accepted result
```

Private zkVM witness:

```text
x and y coordinates
crop pixels
tile pixels and index
Merkle siblings and path directions
```

The verifier checks the RISC Zero receipt against the compiled guest image ID
and checks its journal against the expected public inputs.

## Test

```bash
pnpm test
cargo test --workspace
pnpm real:demo
```

The Node suite scans all 1,536 aligned tiles across the six real puzzles and
asserts that only the six labeled Waldo tiles pass. It also checks commitments,
private-witness binding, proof privacy, and negative protocol cases.

## Other Profiles

The repository retains a fast synthetic local-attestation harness and a compact
RISC Zero fixture for engineering regression tests:

```bash
pnpm demo
pnpm zkvm:prove
pnpm zkvm:verify
pnpm serve
```

The local attestation backend is not cryptographically sound. The
`risc0-zkvm-3.0.5-real-cnn` path is the real end-to-end cryptographic backend.

## Layout

```text
apps/real-demo/         Split-screen six-puzzle prover and verifier
demo/real/              Puzzle catalog, commitments, and private local fixtures
models/artifacts/       Canonical trained quantized CNN bundle
packages/zkvm/          RISC Zero guest, shared core, and host CLI
proofs/                 Generated RISC Zero receipts
reports/                Model, receipt, commitment, and security reports
scripts/                Training, preparation, and demo-server tools
src/                    Merkle, PNG, protocol, and integer-CNN code
test/                   Node regression suite
```
