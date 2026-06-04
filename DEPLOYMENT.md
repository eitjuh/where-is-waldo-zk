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

## VPS (private host)

Private SSH targets and hostnames live in **`deploy.private.env`** (gitignored).
Copy [`deploy.private.env.example`](./deploy.private.env.example) and fill it in.

The app runs as a user-level systemd service on the VPS at `~/srv/zk-waldo`
without changing Caddy, PHP, or your existing tunnel hostnames.

| Piece | Detail |
|-------|--------|
| App | `systemctl --user` service `zk-waldo.service` on `127.0.0.1:4174` |
| zkVM host | Prebuilt Linux binary at `~/srv/zk-waldo/bin/zk-waldo-zkvm-host` |
| Public URL | `https://$ZK_WALDO_PUBLIC_HOST` via Cloudflare tunnel (see DNS below) |
| Redeploy | `scripts/vps/deploy.sh` (reads `deploy.private.env`) |

Build the Linux host binary locally (recommended on a small VPS):

```bash
scripts/vps/build-host-docker.sh
scripts/vps/deploy.sh
```

### Cloudflare DNS (same tunnel as `demo`)

Use the **same CNAME target** as your other tunnel records (e.g. `demo`): one
tunnel, multiple hostnames. The tunnel ingress on the VPS routes by hostname
(`waldo` → `http://127.0.0.1:4174`; `demo` / `api` → Caddy on `443`). See
`scripts/vps/cloudflared-ingress.snippet.yaml`.

Until DNS propagates, use an SSH tunnel (values from `deploy.private.env`):

```bash
ssh -N -L "${ZK_WALDO_SSH_TUNNEL_PORT:-4174}:127.0.0.1:4174" "$ZK_WALDO_SSH_REMOTE"
```

Optional: [Tailscale Serve](https://tailscale.com/kb/1312/serve) on the VPS for
tailnet-only HTTPS (`tailscale serve --bg http://127.0.0.1:4174`).

Production flags on the VPS service:

```bash
ZK_WALDO_PREFER_LOCAL_PROVER=0
ZK_WALDO_HOST_BIN=~/srv/zk-waldo/bin/zk-waldo-zkvm-host
HOST=127.0.0.1
PORT=4174
```

Proving uses `RISC0_PROVER=ipc` and needs the **r0vm** binary (`rzup install` on the VPS).
`scripts/vps/write-prover-env.sh` writes `~/.config/zk-waldo/prover.env` for systemd.

On a **2 GB RAM** VPS, proof generation is usually **OOM-killed** without swap. Once per
machine (requires sudo):

```bash
bash ~/srv/zk-waldo/scripts/vps/add-swap.sh 4G
```

Wrong tiles return **422** `CNN_REJECTED`; a missing prover returns **503**
`PROVER_NOT_CONFIGURED` instead of a generic 500.

`POST /api/real/prove` returns **202** immediately with a `job_id`; the UI polls
`GET /api/real/prove/jobs/:id` until done. This avoids Cloudflare **524** timeouts
(~100s limit).

**Prove speed:** ~20s on a dev laptop with `pnpm real:prove:daemon` (loopback).
The public VPS uses a **release** host binary, but shared 3 vCPU hosts are still
much slower than your Mac. For a comfortable demo, run the local prover and keep
`ZK_WALDO_PREFER_LOCAL_PROVER=1` in the browser (default for local `pnpm real:serve`).

Rebuild the optimized Linux host after guest changes:

```bash
scripts/vps/build-host-docker.sh   # release build
scripts/vps/deploy.sh
```

## Known limits

- Remote provers still receive witness JSON during `prove-real`.
- Classifier acceptance is not objective identity proof.
- Six demo pages participate in catalog training; holdout pages are excluded
  from training positives (see `metrics.holdout_*` in the model bundle).
