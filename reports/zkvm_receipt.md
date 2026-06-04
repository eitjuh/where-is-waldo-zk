# Real RISC Zero Receipt Report

## Backend And Statement

```text
backend: risc0-zkvm-3.0.5-real-cnn
receipt: proofs/end_to_end_real.risc0.json
```

The no-std RISC Zero guest proves:

```text
Given the public image root, trained model hash, preprocessing hash, threshold,
and fixed 1024x1024 image / 64x64 crop parameters, the prover knows a private
aligned crop, tile coordinates, and Merkle path such that:

1. the private tile is included in the committed real puzzle image;
2. the frozen trained quantized CNN accepts the private crop;
3. the model, preprocessing, threshold, and dimensions match the agreed values.
```

The guest uses a fixed raw-byte ABI. Its journal contains only public statement
bytes and an accepted result. The host verifies the receipt with
`Receipt::verify` against the compiled guest image ID, then checks the journal
byte-for-byte against the expected public statement.

## Commands

```bash
pnpm real:prepare
pnpm real:exec
pnpm real:prove
pnpm real:verify
```

## Verified Local Run

```text
private CNN logit: 5248460
guest user cycles: 181048
total zkVM cycles: 262144
prove_ms: 20005
proof JSON bytes: 343448
verification: valid
location: hidden
crop: hidden
```

All six puzzle fixtures execute successfully inside the same guest with about
181,050 user cycles each. The split-screen demo chooses the correct commitment
for proving and identifies an uploaded proof's page from its public image root.
A wrong tile is rejected before proving, and tampered receipt fields are
rejected by the verifier.

## Privacy Boundary

The receipt omits:

```text
x and y
crop pixels
tile pixels and tile index
Merkle siblings and path directions
private CNN logit
```

The current web prover runs as a local server process. It sees the clicked
coordinate while building the witness. Run it locally; a production web
deployment should move proof generation into a local/trusted prover process.
