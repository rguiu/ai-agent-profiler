#!/bin/sh
# Install aap: build + link the CLI, then set up the home config under ~/.aap/.
#
# Steps:
#   1. npm install + build + link  -> puts `aap` on your PATH (dist/cli/aap.js)
#   2. Create ~/.aap/ and ~/.aap/data/
#   3. If ~/.aap/config.toml is missing, seed it from the project's config.toml
#      (falling back to config.example.toml) and point storage at ~/.aap/data.
#
# aap resolves config in this order: $AAP_CONFIG -> ~/.aap/config.toml -> ./config.toml
# so after install, aap works from any directory. Re-running is safe: deps rebuild
# and an existing ~/.aap/config.toml is never overwritten.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
AAP_HOME="$HOME/.aap"
DEST="$AAP_HOME/config.toml"
DATA="$AAP_HOME/data"

# 1. Build + link the CLI so `aap` is on PATH.
command -v npm >/dev/null 2>&1 || {
  echo "error: npm not found — install Node.js >= 20 first" >&2; exit 1; }
echo "==> installing dependencies + building + linking aap ..."
( cd "$HERE" && npm install && npm run build && npm link )
echo "==> linked: $(command -v aap 2>/dev/null || echo 'aap (restart your shell if not found)')"

# 2. Home dir + storage.
mkdir -p "$AAP_HOME" "$DATA"

# 3. Seed the home config (never clobber an existing one).
if [ -f "$DEST" ]; then
  echo "config already exists, leaving it untouched: $DEST"
  echo "storage dir: $DATA"
  exit 0
fi

if [ -f "$HERE/config.toml" ]; then
  SRC="$HERE/config.toml"
elif [ -f "$HERE/config.example.toml" ]; then
  SRC="$HERE/config.example.toml"
else
  echo "error: no config.toml or config.example.toml in $HERE" >&2
  exit 1
fi

cp "$SRC" "$DEST"

# Point storage at ~/.aap/data (absolute, so cwd never matters). Replace an
# existing [storage] dir line, or append a [storage] block if none is present.
if grep -q '^[[:space:]]*dir[[:space:]]*=' "$DEST"; then
  tmp="$DEST.tmp"
  awk -v d="$DATA" '
    /^[[:space:]]*dir[[:space:]]*=/ && !done { print "dir = \"" d "\""; done=1; next }
    { print }
  ' "$DEST" > "$tmp" && mv "$tmp" "$DEST"
else
  printf '\n[storage]\ndir = "%s"\n' "$DATA" >> "$DEST"
fi

echo "created $DEST (from $(basename "$SRC"))"
echo "storage dir: $DATA"
echo
echo "Next: set your provider keys/pricing in $DEST, then run 'aap serve'."
