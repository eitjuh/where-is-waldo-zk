#!/usr/bin/env bash
set -euo pipefail

CONFIG="${HOME}/.cloudflared/config.yml"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "$ROOT/deploy.private.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/deploy.private.env"
  set +a
fi
HOSTNAME="${ZK_WALDO_PUBLIC_HOST:-waldo.example.com}"
MARKER="$HOSTNAME"

if grep -q "$MARKER" "$CONFIG" 2>/dev/null; then
  echo "Cloudflared already routes $MARKER"
  exit 0
fi

cp "$CONFIG" "${CONFIG}.bak.$(date +%Y%m%d%H%M%S)"
export ZK_WALDO_INGRESS_HOST="$HOSTNAME"
python3 - <<'PY'
from pathlib import Path
import os
import sys

hostname = os.environ["ZK_WALDO_INGRESS_HOST"]
config = Path.home() / ".cloudflared" / "config.yml"
text = config.read_text()
block = f"""  - hostname: {hostname}
    service: http://127.0.0.1:4174
"""
if hostname in text:
    sys.exit(0)
needle = "  - service: http_status:404"
if needle not in text:
    raise SystemExit("Could not find cloudflared catch-all rule; edit config manually.")
config.write_text(text.replace(needle, block + needle, 1))
print("Patched", config)
PY

systemctl --user restart cloudflared.service
echo "Restarted cloudflared. Public URL: https://${HOSTNAME}/"
