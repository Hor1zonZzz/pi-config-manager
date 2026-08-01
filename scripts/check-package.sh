#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT"
TARBALL="$(npm pack --silent --pack-destination "$TMP_DIR" | tail -n 1)"
tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"

for file in \
  package/package.json \
  package/README.md \
  package/THIRD_PARTY_NOTICES.md \
  package/src/index.ts \
  package/src/policy-manager.ts \
  package/src/preset-editor.ts \
  package/src/presets.ts \
  package/skills/preset-settings/SKILL.md; do
  test -f "$TMP_DIR/$file" || {
    echo "Missing package artifact: $file" >&2
    exit 1
  }
done

"$ROOT/node_modules/.bin/pi" \
  --no-extensions \
  -e "$TMP_DIR/package/src/index.ts" \
  --list-models >/dev/null

echo "Package artifact and Pi extension entrypoint verified."
