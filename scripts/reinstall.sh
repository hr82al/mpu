#!/usr/bin/env bash
# Reinstall mpu tool + refresh shell completions for all entry points.
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

# Список команд из [project.scripts] секции pyproject.toml — без хардкода.
COMMANDS=$(awk '
    /^\[project\.scripts\]/ { in_section = 1; next }
    /^\[/                   { in_section = 0 }
    in_section && /=/       { print $1 }
' pyproject.toml)

echo "→ installing $SHELL_NAME completions for:"
echo "$COMMANDS" | sed 's/^/    /'
for cmd in $COMMANDS; do
    if "$cmd" --install-completion "$SHELL_NAME" >/dev/null 2>&1; then
        :
    else
        echo "  warn: $cmd --install-completion failed (skip)" >&2
    fi
done

echo "✓ done. Open a new $SHELL_NAME session to activate completions."
