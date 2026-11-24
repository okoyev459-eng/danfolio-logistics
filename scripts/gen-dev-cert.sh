#!/bin/sh
# Generate the self-signed certificate used by `npm run dev:https`.
#
# Why this exists: browsers only allow the Geolocation API on secure
# contexts (https:// or localhost). Phones on the LAN open the app via
# http://<lan-ip>:5173, which is NOT a secure context — the rider's device
# would hard-fail ("Only secure origins are allowed") and live tracking
# could never publish. This certificate makes the dev server usable over
# https:// so real phones can grant location and publish GPS.
#
# No new dependencies: uses the system `openssl`. The certificate is
# self-signed and dev-only (never deployed, git-ignored under .cert/).
#
# Usage:
#   sh scripts/gen-dev-cert.sh            # create if missing (no-op if present)
#   sh scripts/gen-dev-cert.sh --force    # regenerate (e.g. after changing Wi-Fi)
set -e
cd "$(dirname "$0")/.."

if [ -f .cert/dev-cert.pem ] && [ "$1" != "--force" ]; then
  echo "[dev-cert] already present (.cert/dev-cert.pem) — use --force to regenerate"
  exit 0
fi

mkdir -p .cert

# Include the current LAN IP so the phone's certificate warning can be
# proceeded past; regenerate after switching networks.
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
SAN="DNS:localhost,IP:127.0.0.1,IP:::1"
if [ -n "$LAN_IP" ]; then
  SAN="$SAN,IP:$LAN_IP"
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout .cert/dev-key.pem \
  -out .cert/dev-cert.pem \
  -subj "/CN=Danfolio dev" \
  -addext "subjectAltName=$SAN" >/dev/null 2>&1

echo "[dev-cert] written to .cert/ (SAN: $SAN)"
