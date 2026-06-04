#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "$ROOT/deploy.private.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/deploy.private.env"
  set +a
fi

REMOTE="${REMOTE:-${ZK_WALDO_SSH_REMOTE:-}}"
if [ -z "$REMOTE" ]; then
  echo "Set ZK_WALDO_SSH_REMOTE in deploy.private.env (see deploy.private.env.example)." >&2
  exit 1
fi

APP_DIR="srv/zk-waldo"

echo "Syncing $ROOT -> $REMOTE:~/$APP_DIR"
rsync -az --delete \
  --exclude node_modules \
  --exclude target \
  --exclude .git \
  --exclude demo/real/runtime \
  --exclude models/release.pem \
  --exclude .DS_Store \
  "$ROOT/" "$REMOTE:~/$APP_DIR/"

HOST_BIN="$ROOT/target/release/zk-waldo-zkvm-host"
if [ ! -f "$HOST_BIN" ]; then
  HOST_BIN="$ROOT/target/debug/zk-waldo-zkvm-host"
fi
if [ -f "$HOST_BIN" ]; then
  echo "Uploading prebuilt zkVM host binary ($(basename "$(dirname "$HOST_BIN")"))..."
  ssh "$REMOTE" "mkdir -p ~/srv/zk-waldo/bin"
  rsync -az "$HOST_BIN" "$REMOTE:~/srv/zk-waldo/bin/zk-waldo-zkvm-host"
else
  echo "No linux binary — run: scripts/vps/build-host-docker.sh"
fi

echo "Running remote setup (Node, catalog, optional on-VPS cargo build)..."
ssh "$REMOTE" "chmod +x ~/srv/zk-waldo/scripts/vps/setup.sh && APP_DIR=\$HOME/srv/zk-waldo bash \$HOME/srv/zk-waldo/scripts/vps/setup.sh" || true

echo "Configuring RISC Zero prover (r0vm)..."
ssh "$REMOTE" 'chmod +x ~/srv/zk-waldo/scripts/vps/write-prover-env.sh && ~/srv/zk-waldo/scripts/vps/write-prover-env.sh'

echo "Installing systemd user service..."
ssh "$REMOTE" 'mkdir -p ~/.config/systemd/user && cp ~/srv/zk-waldo/scripts/vps/zk-waldo.service ~/.config/systemd/user/zk-waldo.service && systemctl --user daemon-reload && systemctl --user enable --now zk-waldo.service'

echo "Checking service..."
ssh "$REMOTE" 'systemctl --user status zk-waldo.service --no-pager | head -15; curl -sf http://127.0.0.1:4174/healthz || echo healthz failed'

echo "Done. Configure Cloudflare tunnel hostname if not already applied (see scripts/vps/cloudflared-ingress.snippet.yaml)."
