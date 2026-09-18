#!/usr/bin/env bash
# Установка новых частей рядом со старым mpu
# (docs/specs/platform/supervisor-install.md, «ts/install.sh»):
# mpu-back, mpu-mcp, mpu-next, mpu-supervisor, mpu-complete и служба
# mpu-next.service (mpu-complete — без службы: его зовёт оболочка).
# Старую программу, её службу и её порт скрипт не знает и не трогает.
#
#   ./install.sh [--only back,mcp,cli,supervisor,complete] [--check]
#
# Права и состав сборки — только в задачах compile:* корневого deno.jsonc;
# здесь их нет. Переопределения окружением — для тестов: MPU_BIN_DIR,
# MPU_UNIT_DIR, MPU_SYSTEMCTL, MPU_DENO, MPU_BACK_URL, MPU_MCP_URL.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
bin_dir=${MPU_BIN_DIR:-$HOME/.local/bin}
unit_dir=${MPU_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
systemctl=${MPU_SYSTEMCTL:-systemctl}
deno=${MPU_DENO:-deno}
back_url=${MPU_BACK_URL:-http://127.0.0.1:7338}
mcp_url=${MPU_MCP_URL:-http://127.0.0.1:7339}
unit=mpu-next.service
wait_seconds=15

say() { printf 'install: %s\n' "$*"; }
fail() { say "$1: ошибка: $2"; exit 1; }

# Часть → программа.
program_of() {
  case $1 in
    back) echo mpu-back ;;
    mcp) echo mpu-mcp ;;
    cli) echo mpu-next ;;
    supervisor) echo mpu-supervisor ;;
    complete) echo mpu-complete ;;
    *) return 1 ;;
  esac
}

parts=(back mcp cli supervisor complete)
check=0
while (($# > 0)); do
  case $1 in
    --only)
      [[ $# -ge 2 ]] || fail "аргументы" "--only без списка"
      IFS=, read -r -a parts <<<"$2"
      shift 2
      ;;
    --check) check=1; shift ;;
    *) fail "аргументы" "неизвестный аргумент $1" ;;
  esac
done
for part in "${parts[@]}"; do
  program_of "$part" >/dev/null || fail "аргументы" "нет части $part"
done

# 1. Сборка — во временный каталог рядом с целью (подмена mv атомарна в
# пределах одного каталога); у --check цель не трогается вовсе.
if ((check)); then
  work=$(mktemp -d "${TMPDIR:-/tmp}/mpu-install.XXXXXX")
else
  mkdir -p "$bin_dir" || fail "сборка" "нет каталога $bin_dir"
  work=$(mktemp -d "$bin_dir/.mpu-install.XXXXXX")
fi
trap 'rm -rf "$work"' EXIT

declare -A version
for part in "${parts[@]}"; do
  program=$(program_of "$part")
  if ! log=$(cd "$here" && MPU_OUT="$work/$program" "$deno" task "compile:$part" 2>&1); then
    fail "сборка $part" "$(tail -n 1 <<<"$log")"
  fi
  if ! version[$part]=$("$work/$program" --version 2>&1); then
    fail "сборка $part" "не отвечает на --version"
  fi
  say "сборка $part: собрано (${version[$part]})"
done

# 2. Сравнение по sha256 собранного и установленного.
changed=()
for part in "${parts[@]}"; do
  program=$(program_of "$part")
  new=$(sha256sum "$work/$program" | cut -d' ' -f1)
  old=$(sha256sum "$bin_dir/$program" 2>/dev/null | cut -d' ' -f1)
  if [[ $new == "$old" ]]; then
    say "сравнение $part: без изменений"
  else
    say "сравнение $part: изменилось"
    changed+=("$part")
  fi
done

# 3. --check — только сборка и сравнение.
if ((check)); then
  say "готово"
  exit 0
fi

# 4. Установка изменившихся.
for part in "${changed[@]}"; do
  program=$(program_of "$part")
  mv -f "$work/$program" "$bin_dir/$program" || fail "установка $part" "mv не удался"
  say "установка $part: поставлено"
done

# 5. Служба: эталонный файл, при расхождении — записать, перечитать, включить.
unit_changed=0
if cmp -s "$here/supervisor/$unit" "$unit_dir/$unit"; then
  say "служба: без изменений"
else
  mkdir -p "$unit_dir" || fail "служба" "нет каталога $unit_dir"
  cp "$here/supervisor/$unit" "$unit_dir/$unit" || fail "служба" "не записана"
  "$systemctl" --user daemon-reload || fail "служба" "daemon-reload"
  "$systemctl" --user enable mpu-next || fail "служба" "enable"
  unit_changed=1
  say "служба: записана"
fi

# 6. Перезапуск: не активна — start; изменились супервизор или служба —
# restart; иначе сигнал только главному процессу службы (супервизору):
# без --kill-whom=main systemd разослал бы его и дочерним, а для них
# USR1/USR2 — завершение.
has() { [[ " ${changed[*]} " == *" $1 "* ]]; }
# Номер процесса из /health: у старого и нового процесса версия одна, и
# отличить новый можно только по нему.
pid_of() {
  curl -fsS "$1/health" 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p'
}
# Снятые до перезапуска номера: проверка ждёт ответа с другим. Пусто —
# ждать нечего (служба не работала или часть не перезапускается).
old_back=""
old_mcp=""
restarted=0
if ! "$systemctl" --user is-active --quiet mpu-next; then
  "$systemctl" --user start mpu-next || fail "перезапуск" "start"
  restarted=1
  say "перезапуск: служба запущена"
elif has supervisor || ((unit_changed)); then
  old_back=$(pid_of "$back_url")
  old_mcp=$(pid_of "$mcp_url")
  "$systemctl" --user restart mpu-next || fail "перезапуск" "restart"
  restarted=1
  say "перезапуск: служба перезапущена"
else
  if has back; then
    old_back=$(pid_of "$back_url")
    "$systemctl" --user kill --kill-whom=main -s USR1 mpu-next || fail "перезапуск" "USR1"
    restarted=1
    say "перезапуск: back"
  fi
  if has mcp; then
    old_mcp=$(pid_of "$mcp_url")
    "$systemctl" --user kill --kill-whom=main -s USR2 mpu-next || fail "перезапуск" "USR2"
    restarted=1
    say "перезапуск: mcp"
  fi
  ((restarted)) || say "перезапуск: не нужен"
fi

# 7. Проверка — до 15 секунд на каждую; нет ответа — ошибка, не пропуск.
until_ok() {
  local deadline=$((SECONDS + wait_seconds))
  while ((SECONDS < deadline)); do
    "$@" && return 0
    sleep 0.2
  done
  return 1
}

# Ответил новый процесс: номер есть и не тот, что до перезапуска.
fresh() {
  local now
  now=$(pid_of "$1")
  [[ -n $now && $now != "$2" ]]
}
back_ok() {
  local body
  body=$(curl -fsS "$back_url/health" 2>/dev/null) || return 1
  [[ -z ${version[back]:-} || $body == *"\"version\":\"${version[back]}\""* ]] &&
    fresh "$back_url" "$old_back"
}
mcp_ok() {
  fresh "$mcp_url" "$old_mcp" &&
    [[ $(curl -s -o /dev/null -w '%{http_code}' -X POST "$mcp_url/mcp" 2>/dev/null) == 401 ]]
}
next_ok() {
  local said
  said=$(MPU_BACK_URL=$back_url "$bin_dir/mpu-next" version 2>/dev/null) || return 1
  [[ -z ${version[cli]:-} || $said == "${version[cli]}" ]]
}

until_ok back_ok || fail "проверка back" "нет ответа 200 с версией на $back_url/health"
say "проверка back: отвечает"
until_ok mcp_ok || fail "проверка mcp" "нет ответа 401 на $mcp_url/mcp"
say "проверка mcp: отвечает"
until_ok next_ok || fail "проверка cli" "mpu-next version не отвечает"
say "проверка cli: отвечает"

say "готово"
