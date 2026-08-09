#!/usr/bin/env bash
# Reinstall mpu tool + refresh shell completion для единого `mpu` бинаря.
# Usage: ./scripts/reinstall.sh [bash|zsh|fish]
# Без аргумента — берёт shell из $SHELL.
# Completion поддерживается только для bash/zsh/fish (typer); любой другой
# shell (в т.ч. nu) — бинарь всё равно переустанавливается, шаг completion
# просто пропускается.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SHELL_NAME="${1:-$(basename "${SHELL:-bash}")}"

echo "→ uv tool install --from . mpu --force --reinstall"
uv tool install --from . mpu --force --reinstall

case "$SHELL_NAME" in
    bash|zsh|fish)
        echo "→ mpu --install-completion $SHELL_NAME"
        if mpu --install-completion "$SHELL_NAME" >/dev/null 2>&1; then
            echo "    completion installed"
        else
            echo "  warn: mpu --install-completion failed" >&2
        fi
        echo "✓ done. Open a new $SHELL_NAME session to activate completions."
        ;;
    *)
        echo "  skip: completion not supported for shell '$SHELL_NAME' (expected bash|zsh|fish)" >&2
        echo "✓ done (mpu reinstalled, no completion for '$SHELL_NAME')."
        ;;
esac
