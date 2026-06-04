#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/srv/zk-waldo}"
export PATH="$HOME/.local/share/fnm:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.risc0/bin:$PATH"

install_fnm_node() {
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$HOME/.local/share/fnm" --skip-shell
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env)"
    fnm install 22
    fnm default 22
  fi
  eval "$(fnm env 2>/dev/null || true)"
  corepack enable
  corepack prepare pnpm@latest --activate
}

install_rust() {
  if ! command -v cargo >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  fi
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
}

install_risc0() {
  export PATH="$HOME/.risc0/bin:$PATH"
  if ! command -v rzup >/dev/null 2>&1; then
    curl -L https://risczero.com/install | bash
    export PATH="$HOME/.risc0/bin:$PATH"
  fi
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
  rzup install rust
  rzup install cpp
}

install_zig_cc() {
  if command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; then
    return 0
  fi
  local zig="$HOME/zig/zig"
  if [ ! -x "$zig" ]; then
    echo "Installing Zig as portable C toolchain..."
    curl -fsSL -o /tmp/zig.tar.xz https://ziglang.org/download/0.14.0/zig-linux-x86_64-0.14.0.tar.xz
    tar -xf /tmp/zig.tar.xz -C /tmp
    rm -rf "$HOME/zig"
    mv /tmp/zig-linux-x86_64-0.14.0 "$HOME/zig"
    mkdir -p "$HOME/bin"
    ln -sf "$HOME/zig/zig" "$HOME/bin/zig"
  fi
  mkdir -p "$HOME/bin"
  write_zig_compiler_wrapper() {
    local name="$1"
    cat >"$HOME/bin/$name" <<'EOF'
#!/bin/sh
zig="$HOME/zig/zig"
cmd=cc
[ "$(basename "$0")" = c++ ] && cmd=c++
args=""
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    --target=*) ;;
    -target) skip=1 ;;
    *) args="$args $arg" ;;
  esac
done
# shellcheck disable=SC2086
exec "$zig" "$cmd" -target x86_64-linux-gnu $args
EOF
    chmod +x "$HOME/bin/$name"
  }
  write_zig_compiler_wrapper cc
  cp "$HOME/bin/cc" "$HOME/bin/c++"
  chmod +x "$HOME/bin/c++"
  cat >"$HOME/bin/ar" <<EOF
#!/bin/sh
exec "$HOME/zig/zig" ar "\$@"
EOF
  chmod +x "$HOME/bin/ar"
  export CC="$HOME/bin/cc"
  export CXX="$HOME/bin/c++"
  export AR="$HOME/bin/ar"
}

cd "$APP_DIR"
install_fnm_node
install_rust
install_risc0
install_zig_cc
export CC="${CC:-$HOME/bin/cc}"

pnpm install --frozen-lockfile 2>/dev/null || pnpm install
node scripts/prepare-real-demo.mjs
if ! node scripts/bundle-witness-client.mjs 2>/dev/null; then
  echo "WARN: witness bundle step failed; sync apps/real-demo/witness-client.bundle.js from dev machine if needed."
fi

if [ -x "$APP_DIR/bin/zk-waldo-zkvm-host" ]; then
  echo "Using prebuilt zkVM host at $APP_DIR/bin/zk-waldo-zkvm-host"
elif command -v cc >/dev/null 2>&1 || [ -x "$HOME/bin/cc" ]; then
  echo "Building zkVM host on VPS (first run may take several minutes)..."
  export CARGO_BUILD_JOBS=1
  export CC="${CC:-$HOME/bin/cc}"
  export CXX="${CXX:-$HOME/bin/c++}"
  export AR="${AR:-$HOME/bin/ar}"
  cargo build -p zk-waldo-zkvm-host && install -m 755 target/debug/zk-waldo-zkvm-host "$APP_DIR/bin/zk-waldo-zkvm-host"
else
  echo "WARN: no prebuilt host binary and no C toolchain. Run scripts/vps/build-host-docker.sh locally, then redeploy."
fi

chmod +x "$APP_DIR/scripts/vps/write-prover-env.sh"
"$APP_DIR/scripts/vps/write-prover-env.sh"

echo "Setup complete in $APP_DIR"
echo "If prove fails with Killed/OOM on a 2GB VPS, run once: scripts/vps/add-swap.sh (requires sudo)."
