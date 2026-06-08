#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/forge"

mkdir -p "$BIN_DIR"

cat > "$TARGET" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
exec node engine/forge.mjs "\$@"
EOF

chmod +x "$TARGET"

echo "Installed forge to $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "Note: $BIN_DIR is not in PATH."
    echo "Add this to your shell profile, then restart the shell:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
