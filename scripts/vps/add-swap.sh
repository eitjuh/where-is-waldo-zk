#!/usr/bin/env bash
# One-time on the VPS (requires sudo). RISC Zero proving needs >2GB RAM on this demo.
set -euo pipefail

SIZE="${1:-4G}"
SWAPFILE="${SWAPFILE:-/swapfile}"

if swapon --show | grep -q "$SWAPFILE"; then
  echo "Swap already active: $SWAPFILE"
  swapon --show
  exit 0
fi

sudo fallocate -l "$SIZE" "$SWAPFILE"
sudo chmod 600 "$SWAPFILE"
sudo mkswap "$SWAPFILE"
sudo swapon "$SWAPFILE"
echo "Swap enabled:"
swapon --show
free -h
