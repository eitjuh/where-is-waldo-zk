#!/usr/bin/env bash
# Run on the VPS after: CARGO_BUILD_JOBS=1 cargo build --release -p zk-waldo-zkvm-host
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/srv/zk-waldo}"
BIN="$APP_DIR/target/release/zk-waldo-zkvm-host"

if [ ! -x "$BIN" ]; then
  echo "Missing $BIN — build first:" >&2
  echo "  cd $APP_DIR && CARGO_BUILD_JOBS=1 cargo build --release -p zk-waldo-zkvm-host" >&2
  exit 1
fi

install -m 755 "$BIN" "$APP_DIR/bin/zk-waldo-zkvm-host"
"$APP_DIR/scripts/vps/write-prover-env.sh"
systemctl --user restart zk-waldo.service
echo "Installed release host binary and restarted zk-waldo."
