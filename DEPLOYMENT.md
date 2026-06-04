# Deployment Guide

Production deployment splits three roles:

| Role | Command | Learns coordinates? |
|------|---------|---------------------|
| Browser UI | static `apps/real-demo` | Builds witness locally |
| Local prover | `pnpm real:prove:daemon` | Witness JSON only (loopback) |
| Verifier | `pnpm real:serve` or static hosting | Never |

## Recommended startup (production)

Terminal 1 — local prover (loopback only):

```bash
pnpm real:prove:daemon
```

Terminal 2 — verifier + static UI:

```bash
pnpm real:serve
```

Open `http://127.0.0.1:4174/`. The UI builds witnesses in the browser, then
posts them to `http://127.0.0.1:4175/api/real/prove` by default. Click
coordinates are not sent to either API.

## Environment flags

```bash
HOST=127.0.0.1
PORT=4174
ZK_WALDO_PROVER_HOST=127.0.0.1
ZK_WALDO_PROVER_PORT=4175
ZK_WALDO_ALLOW_COORDINATE_WITNESS=0
ZK_WALDO_TRUST_REMOTE=0
ZK_WALDO_PREFER_LOCAL_PROVER=1
ZK_WALDO_PROVE_RATE_LIMIT=6
```

Set `ZK_WALDO_REQUIRE_LOCAL_PROVER=1` in the demo server environment to reject
fallback proving when the local daemon is offline.

## Model registry signatures

Published models are pinned in `models/registry.json` and signed with the
Ed25519 public key in `models/release.pub`.

```bash
pnpm real:release:keygen   # once, keeps models/release.pem local/gitignored
pnpm real:release:sign     # after registry or model changes
pnpm audit:guest           # rust guest constants vs registry vs bundle
```

Verifiers load the registry signature during `loadRealModel()`.

## Build and release checklist

```bash
pnpm install
pnpm real:prepare
pnpm check
pnpm real:eval:holdout     # optional, requires /tmp/hey-waldo
```

## Docker (verifier-oriented)

```bash
docker build -t zk-waldo-verifier .
docker run --rm -p 4174:4174 zk-waldo-verifier
```

Run `pnpm real:prove:daemon` on the host when proving is required. The sample
image does not replace a loopback prover.

## Merkle hash (v1)

This release keeps SHA-256 domain-separated Merkle trees for host/guest/JS
parity. Poseidon migration is tracked in `engineering_plan.md` as a v2
performance item and would require new public roots.

## Artwork

See [`NOTICE.md`](./NOTICE.md). Distribution rights for the puzzle pages are
assumed cleared for this project.

## Known limits

- Remote provers still receive witness JSON during `prove-real`.
- Classifier acceptance is not objective identity proof.
- Six demo pages participate in catalog training; holdout pages are excluded
  from training positives (see `metrics.holdout_*` in the model bundle).
