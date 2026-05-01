#!/usr/bin/env bash
# Собирает new-mpu и ставит симлинки в ~/.local/bin (или $BIN_DIR).
# Симлинки указывают на dist/ внутри репозитория — никакого global node_modules.
#
# Usage:
#   bash scripts/install.sh                # npm install (если нужно) + build + install
#   bash scripts/install.sh --no-build     # только перерегистрировать симлинки
#   BIN_DIR=/somewhere bash scripts/install.sh   # переопределить путь установки
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

build=1
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -d node_modules ]; then
  echo "→ npm install"
  npm install
fi

if [ "$build" = 1 ]; then
  echo "→ npm run build"
  npm run build
fi

mkdir -p "$BIN_DIR"

install_bin() {
  local name="$1"
  local src="$2"
  local dst="$BIN_DIR/$name"
  if [ ! -f "$src" ]; then
    echo "✗ build artifact not found: $src" >&2
    echo "  run \`npm run build\` first, or remove --no-build" >&2
    exit 1
  fi
  ln -sfn "$src" "$dst"
  echo "  $dst → $src"
}

echo "→ install symlinks"
install_bin new-mpu "$ROOT/dist/bin/mpu.js"
install_bin sheet   "$ROOT/dist/bin/sheet.js"

echo
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "✓ $BIN_DIR в PATH" ;;
  *)
    echo "⚠ $BIN_DIR не в PATH. Добавь в shell rc:"
    echo "    bash/zsh: export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo "    fish:     fish_add_path \$HOME/.local/bin"
    ;;
esac

echo
echo "✓ installed. Try:"
echo "    new-mpu db --help"
echo "    sheet ls"
