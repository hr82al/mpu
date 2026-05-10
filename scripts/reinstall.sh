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
# Игнорируем строки-комментарии (часто содержат `=` в URL/примерах).
COMMANDS=$(awk '
    /^\[project\.scripts\]/ { in_section = 1; next }
    /^\[/                   { in_section = 0 }
    /^[[:space:]]*#/        { next }
    in_section && /=/       { print $1 }
' pyproject.toml)

# `mpuapi-*` команды реализованы на чистом click (см. _mpuapi_runtime.py) — у них
# нет флага `--install-completion`, поэтому пропускаем их без warning'а.
# Для всех остальных проверяем поддержку через `--help` перед install'ом.
echo "→ installing $SHELL_NAME completions"
for cmd in $COMMANDS; do
    case "$cmd" in
        mpuapi-*) continue ;;
    esac
    if ! "$cmd" --help 2>&1 | grep -q -- "--install-completion"; then
        continue
    fi
    if "$cmd" --install-completion "$SHELL_NAME" >/dev/null 2>&1; then
        echo "    $cmd"
    else
        echo "  warn: $cmd --install-completion failed (skip)" >&2
    fi
done

echo "→ mpu init (bootstrap SQLite, Portainer + Loki labels discovery)"
if mpu init; then
    :
else
    echo "  warn: mpu init returned non-zero (см. вывод выше; обычно — нет PORTAINER_API_KEY/LOKI_URL в ~/.config/mpu/.env)" >&2
fi

echo "✓ done. Open a new $SHELL_NAME session to activate completions."
