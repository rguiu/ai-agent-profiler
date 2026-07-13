#!/bin/sh
# Install aap: set up the home config under ~/.aap/, then build + link the CLI.
#
# Steps (config first, so a build/link failure never leaves ~/.aap empty):
#   1. Create ~/.aap/ and ~/.aap/data/.
#   2. If ~/.aap/config.toml is missing, seed it from the project's config.toml
#      (falling back to config.example.toml) and point storage at ~/.aap/data.
#   3. npm install + build + link -> puts `aap` on your PATH (dist/cli/aap.js).
#      A failing `npm link` (e.g. EACCES on the global prefix) only warns — the
#      config from steps 1-2 is already in place.
#
# aap resolves config in this order: $AAP_CONFIG -> ~/.aap/config.toml -> ./config.toml
# so after install, aap works from any directory. Re-running is safe: deps rebuild
# and an existing ~/.aap/config.toml is never overwritten.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
AAP_HOME="$HOME/.aap"
DEST="$AAP_HOME/config.toml"
DATA="$AAP_HOME/data"

# 1. Home dir + storage. Done first and unconditionally so the config always
#    lands even if the build/link below fails.
mkdir -p "$AAP_HOME" "$DATA"

# 2. Seed the home config (never clobber an existing one).
if [ -f "$DEST" ]; then
  echo "config already exists, leaving it untouched: $DEST"
else
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
fi
echo "storage dir: $DATA"

# 3. Build + link the CLI so `aap` is on PATH.
command -v npm >/dev/null 2>&1 || {
  echo "error: npm not found — install Node.js >= 20 first" >&2; exit 1; }
echo "==> installing dependencies + building + linking aap ..."
( cd "$HERE" && npm install && npm run build )
# `npm link` writes to the global prefix and often fails with EACCES when that
# prefix isn't user-writable. Don't let it abort the install: the config is
# already set up, and the user can link manually or run via `node dist/cli/aap.js`.
if ( cd "$HERE" && npm link ); then
  echo "==> linked: $(command -v aap 2>/dev/null || echo 'aap (restart your shell if not found)')"
else
  echo "warning: 'npm link' failed (often EACCES on the global npm prefix)." >&2
  echo "         The ~/.aap config is set up regardless. To put 'aap' on PATH, retry" >&2
  echo "         with a user-writable prefix, e.g.:" >&2
  echo "             npm config set prefix \"\$HOME/.npm-global\" && (cd \"$HERE\" && npm link)" >&2
  echo "         (then add \$HOME/.npm-global/bin to PATH), or run directly:" >&2
  echo "             node \"$HERE/dist/cli/aap.js\" serve" >&2
fi

echo
echo "Next: set your provider keys/pricing in $DEST, then run 'aap serve'."
