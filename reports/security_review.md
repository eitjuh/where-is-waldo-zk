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

## Production Hardening In This Repository

1. **Client-built witnesses** — the browser bundle constructs the private
   witness locally; the default server rejects coordinate-only prove requests.
2. **Server defaults** — bind to loopback, security headers, prove rate limits,
   catalog reload on `/api/real/config`, and optional legacy coordinate mode via
   `ZK_WALDO_ALLOW_COORDINATE_WITNESS=1`.
3. **Local CLI proving** — `pnpm real:prove:local` runs the host prover without
   HTTP coordinate APIs.
4. **Model registry** — `models/registry.json` pins `model_hash`,
   `preprocessing_hash`, and `threshold_logit` for verifiers.
5. **Holdout training policy** — `train_real_cnn.py` excludes non-catalog Hey-Waldo
   pages from training positives/negatives and records `holdout_*` metrics.
6. **Holdout eval script** — `pnpm real:eval:holdout` writes
   `reports/holdout_eval.json` for pages outside the six-page catalog.
7. **Signed model registry** — Ed25519 signature over `models/registry.json`
   verified at load time; `pnpm audit:guest` checks Rust guest constants.
8. **Local prove daemon** — `pnpm real:prove:daemon` on loopback; browser prefers
   it before the demo server prove endpoint.
9. **CI** — GitHub Actions runs `pnpm test`, `pnpm audit:guest`, `pnpm real:bundle`,
   and `cargo test --workspace`.

## Remaining Before A Public Proving Service

1. Run `pnpm real:prove:daemon` on the user machine so witness JSON never crosses
   the public internet (default UI path).
2. Optional Poseidon Merkle v2 for cycle count (requires new public roots).
3. External third-party audit of the guest relation beyond `pnpm audit:guest`.
4. Expand the catalog beyond six pages with additional licensed training data.
