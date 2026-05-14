#!/usr/bin/env bash
# Reinstall mpu tool + refresh shell completion для единого `mpu` бинаря.
# Usage: ./scripts/reinstall.sh [bash|zsh|fish]
# Без аргумента — берёт shell из $SHELL.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SHELL_NAME="${1:-$(basename "${SHELL:-bash}")}"
case "$SHELL_NAME" in
    bash|zsh|fish) ;;
    *)
        echo "error: unsupported shell '$SHELL_NAME' (expected bash|zsh|fish)" >&2
        exit 2
        ;;
esac

echo "→ uv tool install --from . mpu --force --reinstall"
uv tool install --from . mpu --force --reinstall

echo "→ mpu --install-completion $SHELL_NAME"
if mpu --install-completion "$SHELL_NAME" >/dev/null 2>&1; then
    echo "    completion installed"
else
    echo "  warn: mpu --install-completion failed" >&2
fi

# echo "→ mpu init (bootstrap SQLite, Portainer + Loki labels discovery)"
# if mpu init; then
#     :
# else
#     echo "  warn: mpu init returned non-zero (см. вывод выше; обычно — нет PORTAINER_API_KEY/LOKI_URL в ~/.config/mpu/.env)" >&2
# fi

echo "✓ done. Open a new $SHELL_NAME session to activate completions."
