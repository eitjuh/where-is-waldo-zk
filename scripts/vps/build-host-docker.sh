#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${ZK_WALDO_BUILD_IMAGE:-rust:1-bookworm}"

echo "Building linux/amd64 zk-waldo-zkvm-host in Docker ($IMAGE)..."
docker run --rm --platform linux/amd64 \
  -v "$ROOT":/work -w /work \
  "$IMAGE" \
  bash -ec '
    set -euo pipefail
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential curl ca-certificates pkg-config
    if ! command -v rzup >/dev/null 2>&1; then
      curl -L https://risczero.com/install | bash
    fi
    export PATH="/root/.risc0/bin:/usr/local/cargo/bin:${PATH}"
    if [ -f /root/.cargo/env ]; then
      # shellcheck disable=SC1091
      source /root/.cargo/env
    fi
    rzup install rust
    rzup install cpp
    cargo build --release -p zk-waldo-zkvm-host
    ls -lh target/release/zk-waldo-zkvm-host
  '

echo "Built: $ROOT/target/release/zk-waldo-zkvm-host"
