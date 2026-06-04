# Security Review

## Current Status

The main path is a real end-to-end RISC Zero proof over a real puzzle image and
a trained quantized CNN:

```text
risc0-zkvm-3.0.5-real-cnn
```

Inside the zkVM, the guest verifies the private tile against the public SHA-256
Merkle root, reconstructs the private crop, runs the frozen integer CNN, and
enforces its public threshold. The receipt journal contains only the agreed
public statement and accepted result.

The repository also retains `demo-local-attestation-v0` and compact/synthetic
profiles as fast engineering fixtures. They are not the primary security claim.

## Implemented Checks

- Canonical RGB puzzle bytes produce a deterministic image root.
- A one-pixel mutation changes the image root.
- Private tile coordinates, pixels, and Merkle path must match the public root.
- The private crop must exactly equal the committed tile pixels.
- Real Conv2D, ReLU, flatten, and dense integer inference runs inside
  the RISC Zero guest.
- The model hash, preprocessing hash, threshold, and dimensions are fixed and
  checked inside the guest and by the host verifier.
- The verifier calls `Receipt::verify` against the compiled guest image ID and
  checks the receipt journal against the expected public statement.
- Tests scan all 1,536 tiles across six demo pages and assert that exactly one
  labeled Waldo tile passes per page.
- Privacy tests reject accidental coordinate, crop, tile, witness, sibling, or
  Merkle-path fields in the verifier-facing receipt.
- Wrong clicks and tampered receipt metadata are rejected.

## Honest Limits

- The proof establishes classifier acceptance, not objective identity.
- The six-page demo catalog participates in training; classifier metrics are
  not a broad generalization claim.
- SHA-256 Merkle inclusion is implemented, not the plan's proposed Poseidon
  optimization.
- Crop positions are restricted to aligned `64x64` tiles.
- The browser sends the clicked coordinate to the local prover server. The
  receipt hides it from the verifier, but a remotely hosted prover server would
  learn it.
- The public puzzle makes the answer low entropy. Zero knowledge prevents the
  receipt from disclosing the witness, but it does not make the public puzzle
  hard to solve independently.
- The included real puzzle artwork may have copyright restrictions beyond the
  dataset repository's ODbL label.
- The retained local-attestation profile is forgeable because its key is
  public.

## Remaining Production Hardening

1. Move proving into a local desktop process, browser-capable prover, or trusted
   prover environment so a remote service never receives the selection.
2. Train and evaluate on more licensed pages with a held-out page-level split,
   adversarial tests, and a documented threshold policy.
3. Replace SHA-256 Merkle hashing with a proof-efficient hash if benchmarks
   justify it.
4. Add a model registry or signed release process for the canonical model and
   preprocessing hashes.
5. Audit the guest relation and host/public-input binding before public use.
6. Evaluate EZKL or a custom circuit only as a performance/composition
   alternative; the real end-to-end RISC Zero integration is already complete.
