#!/usr/bin/env bash
# Установка mpu (docs/specs/platform/supervisor-install.md, «ts/install.sh»;
# переключение имён — platform/cutover.md): mpu-back, mpu-worker
# (исполнитель строк — platform/line-executor.md), mpu-mcp, mpu,
# mpu-supervisor, mpu-complete, каталог фронта и служба mpu.service
# (mpu-complete и фронт — без службы: первого зовёт оболочка, второй
# читает mpu-back через ссылку current). Старых служб на машине быть не
# должно: если они есть, установка не начинается — иначе машина
# осталась бы наполовину переключённой. Последними шагами — дополнение
# в оболочках и подключение к Claude Code пользователя.
#
#   ./install.sh [--only back,worker,mcp,cli,supervisor,complete,web] [--check]
#
# Права и состав сборки — только в задачах compile:* корневого deno.jsonc;
# здесь их нет. Переопределения окружением — для тестов: MPU_BIN_DIR,
# MPU_UNIT_DIR, MPU_SYSTEMCTL, MPU_DENO, MPU_BACK_URL, MPU_MCP_URL,
# MPU_WEB_DIR, MPU_CLAUDE.
set -uo pipefail

# Дерево исходников — каталог самого скрипта, а не текущий: скрипт зовут
# откуда придётся и бывает, что по символической ссылке. Ни один путь
# ниже не берётся от $PWD (`platform/cutover.md`).
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
bin_dir=${MPU_BIN_DIR:-$HOME/.local/bin}
unit_dir=${MPU_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
web_dir=${MPU_WEB_DIR:-$HOME/.local/share/mpu/web}
systemctl=${MPU_SYSTEMCTL:-systemctl}
deno=${MPU_DENO:-deno}
back_url=${MPU_BACK_URL:-http://127.0.0.1:7338}
mcp_url=${MPU_MCP_URL:-http://127.0.0.1:7339}
unit=mpu.service
# Службы, оставшиеся от старой установки: рядом с новой они дерутся за
# порт 7338 (`platform/cutover.md`), поэтому установка их не терпит.
old_units=(mpu-mcp.service mpu-next.service)
wait_seconds=15

say() { printf 'install: %s\n' "$*"; }
fail() { say "$1: ошибка: $2"; exit 1; }

# Часть → программа.
program_of() {
  case $1 in
    back) echo mpu-back ;;
    worker) echo mpu-worker ;;
    mcp) echo mpu-mcp ;;
    cli) echo mpu ;;
    supervisor) echo mpu-supervisor ;;
    complete) echo mpu-complete ;;
    web) echo web ;;
    *) return 1 ;;
  esac
}

parts=(back worker mcp cli supervisor complete web)
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

# Старая служба рядом — установка не начинается вовсе: иначе отказ
# пришёл бы уже после подмены программ, и машина осталась бы
# наполовину переключённой (`platform/cutover.md`). Снимается она одной
# командой, и текст отказа её называет: скрипта уборки больше нет, он
# был одноразовым и ушёл вместе с монолитом.
for old in "${old_units[@]}"; do
  [[ -e $unit_dir/$old ]] &&
    fail "служба" "рядом старая служба $old, снимите её: systemctl --user disable --now ${old%.service}"
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

# Хэш каталога фронта: содержимое и относительные пути всех файлов.
dir_digest() {
  (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum) |
    sha256sum | cut -d' ' -f1
}

# Собранное и установленное: программа — sha256 файла; фронт — хэш
# каталога и имя каталога, на который смотрит ссылка current.
new_digest() {
  if [[ $1 == web ]]; then dir_digest "$work/web"; return; fi
  sha256sum "$work/$(program_of "$1")" | cut -d' ' -f1
}
old_digest() {
  if [[ $1 == web ]]; then basename "$(readlink "$web_dir/current" 2>/dev/null)"; return; fi
  sha256sum "$bin_dir/$(program_of "$1")" 2>/dev/null | cut -d' ' -f1
}

declare -A version
for part in "${parts[@]}"; do
  program=$(program_of "$part")
  if ! log=$(cd "$here" && MPU_OUT="$work/$program" "$deno" task "compile:$part" 2>&1); then
    fail "сборка $part" "$(tail -n 1 <<<"$log")"
  fi
  if [[ $part == web ]]; then
    [[ -f $work/web/index.html ]] || fail "сборка web" "нет index.html"
    say "сборка web: собрано"
    continue
  fi
  if ! version[$part]=$("$work/$program" --version 2>&1); then
    fail "сборка $part" "не отвечает на --version"
  fi
  say "сборка $part: собрано (${version[$part]})"
done

# 2. Сравнение по sha256 собранного и установленного.
changed=()
declare -A digest
for part in "${parts[@]}"; do
  new=$(new_digest "$part")
  digest[$part]=$new
  old=$(old_digest "$part")
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

# 4. Установка изменившихся. Фронт — новый каталог web/<хэш>/ рядом с
# прежними и атомарная перестановка ссылки current (прежние сборки
# остаются: откат — ссылкой).
install_web() {
  local target=$web_dir/${digest[web]}
  mkdir -p "$web_dir" || return 1
  [[ -d $target ]] || mv "$work/web" "$target" || return 1
  ln -sfn "${digest[web]}" "$web_dir/current.new" &&
    mv -T "$web_dir/current.new" "$web_dir/current"
}
for part in "${changed[@]}"; do
  if [[ $part == web ]]; then
    install_web || fail "установка web" "каталог не поставлен"
  else
    program=$(program_of "$part")
    mv -f "$work/$program" "$bin_dir/$program" || fail "установка $part" "mv не удался"
  fi
  say "установка $part: поставлено"
done

unit_changed=0
if cmp -s "$here/supervisor/$unit" "$unit_dir/$unit"; then
  say "служба: без изменений"
else
  mkdir -p "$unit_dir" || fail "служба" "нет каталога $unit_dir"
  cp "$here/supervisor/$unit" "$unit_dir/$unit" || fail "служба" "не записана"
  "$systemctl" --user daemon-reload || fail "служба" "daemon-reload"
  "$systemctl" --user enable mpu || fail "служба" "enable"
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
if ! "$systemctl" --user is-active --quiet mpu; then
  "$systemctl" --user start mpu || fail "перезапуск" "start"
  restarted=1
  say "перезапуск: служба запущена"
elif has supervisor || ((unit_changed)); then
  old_back=$(pid_of "$back_url")
  old_mcp=$(pid_of "$mcp_url")
  "$systemctl" --user restart mpu || fail "перезапуск" "restart"
  restarted=1
  say "перезапуск: служба перезапущена"
else
  # Исполнителей запускает ядро: новый mpu-worker берёт в работу только
  # новый mpu-back, поэтому перезапуск — общий (platform/line-executor.md).
  if has back || has worker; then
    old_back=$(pid_of "$back_url")
    "$systemctl" --user kill --kill-whom=main -s USR1 mpu || fail "перезапуск" "USR1"
    restarted=1
    say "перезапуск: back"
  fi
  if has mcp; then
    old_mcp=$(pid_of "$mcp_url")
    "$systemctl" --user kill --kill-whom=main -s USR2 mpu || fail "перезапуск" "USR2"
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
cli_ok() {
  local said
  said=$(MPU_BACK_URL=$back_url "$bin_dir/mpu" version 2>/dev/null) || return 1
  [[ -z ${version[cli]:-} || $said == "${version[cli]}" ]]
}

until_ok back_ok || fail "проверка back" "нет ответа 200 с версией на $back_url/health"
say "проверка back: отвечает"
until_ok mcp_ok || fail "проверка mcp" "нет ответа 401 на $mcp_url/mcp"
say "проверка mcp: отвечает"
until_ok cli_ok || fail "проверка cli" "mpu version не отвечает"
say "проверка cli: отвечает"

# 8. Дополнение: в файле настроек каждой оболочки — один блок между
# маркерами. Блок принадлежит установщику целиком: есть — содержимое
# заменяется на месте, нет — дописывается в конец; совпало — файл не
# переписывается вовсе. Поэтому сколько ни запускай, строк не
# прибавляется (`platform/cutover.md`).
begin_mark='# >>> mpu completion >>>'
end_mark='# <<< mpu completion <<<'

# Файл настроек оболочки; его нет — пусто, и оболочка пропускается.
# Каталог nu спрашивается у самого nu: другого источника у него нет.
config_bash() { [[ -f $HOME/.bashrc ]] && echo "$HOME/.bashrc"; }
config_fish() {
  local file=${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish
  [[ -f $file ]] && echo "$file"
}
config_nu() {
  local dir
  dir=$(nu --no-config-file -c '$nu.default-config-dir' 2>/dev/null) || return 0
  [[ -f $dir/config.nu ]] && echo "$dir/config.nu"
}

# Содержимое блока, как оно лежит сейчас; блока нет — пусто.
block_in() {
  awk -v b="$begin_mark" -v e="$end_mark" \
    '$0==b{inside=1;next} $0==e{inside=0;next} inside' "$1"
}

# Блок на своё место: есть — заменить содержимое, не двигая соседний
# текст; нет — дописать в конец.
#
# Тело уходит в awk переменной ОКРУЖЕНИЯ, а не через `-v`: `-v`
# раскрывает escape-последовательности, а в скриптах дополнения они
# есть дословно (`local IFS=$'\n'` у bash, `split column "\t"` у nu) —
# замер 2026-09-22: `-v` превращает их в настоящие перевод строки и
# табуляцию, то есть кладёт в файл испорченный скрипт.
write_block() {
  local file=$1 body=$2 target tmp
  # Файл настроек бывает символической ссылкой в чужой каталог с
  # точечными файлами: подменять надо то, на что она смотрит, иначе
  # установка снесла бы саму ссылку.
  target=$(readlink -f "$file") || return 1
  tmp=$target.mpu-install
  if grep -Fxq "$begin_mark" "$target"; then
    body="$body" awk -v b="$begin_mark" -v e="$end_mark" \
      '$0==b{print; print ENVIRON["body"]; skip=1; next} $0==e{skip=0} !skip{print}' \
      "$target" >"$tmp" || return 1
  else
    cat "$target" >"$tmp" || return 1
    # Файл без концевого перевода строки: без этого открывающий маркер
    # сел бы на хвост чужой последней строки, поиск маркера (он привязан
    # к началу строки) такого блока не нашёл бы, и следующий прогон
    # дописал бы второй — строки копились бы (замер на живой машине
    # 2026-09-22: `config.fish` и `config.nu` без перевода в конце).
    if [[ -s $tmp ]] && [[ $(tail -c1 "$tmp") != "" ]]; then
      printf '\n' >>"$tmp" || return 1
    fi
    printf '%s\n%s\n%s\n' "$begin_mark" "$body" "$end_mark" >>"$tmp" || return 1
  fi
  mv -f "$tmp" "$target"
}

# Имя дополняемой программы установщик не повторяет: оно умолчание
# `mpu-complete init` (`docs/specs/complete.md`).
hook_shell() {
  local shell=$1 file=$2 body
  body=$("$bin_dir/mpu-complete" init "$shell" 2>/dev/null) ||
    fail "дополнение $shell" "mpu-complete init $shell не отработал"
  if [[ $(block_in "$file") == "$body" ]]; then
    say "дополнение $shell: без изменений"
    return
  fi
  write_block "$file" "$body" || fail "дополнение $shell" "файл не записан"
  say "дополнение $shell: подключено"
}

# Подключать нечем — дополняющей программы на месте нет (её не просили
# ставить: `--only` без `complete` на чистой машине). Это пропуск, а не
# отказ: остальное уже поставлено и работает.
if [[ ! -x $bin_dir/mpu-complete ]]; then
  say "дополнение: mpu-complete не установлен"
else
  for shell in bash fish nu; do
    file=$("config_$shell")
    if [[ -z $file ]]; then
      say "дополнение $shell: не настроена"
      continue
    fi
    hook_shell "$shell" "$file"
  done
fi

# 9. Claude Code: сервер mpu пользователя и правила разрешений. Сервер
# ставит сам claude (файл ~/.claude.json — его, с состоянием сессий),
# правила вписываются в ~/.claude/settings.json дописыванием недостающих:
# чужие правила и ключи не трогаются. Совпало — ни вызова, ни записи.
claude=${MPU_CLAUDE:-claude}
claude_allow='["mcp__mpu__*","Bash(mpu *)"]'
claude_ask='["Bash(mpu ask *)"]'
# Токены на диске агенту не читать (platform/mcp-objects.md).
claude_deny='["Read(~/.config/mpu/**)"]'
# Токен читается при подключении и в конфиг клиента не попадает.
read -r claude_helper <<'HELPER'
printf '{"Authorization":"Bearer %s"}' "$(cat ~/.config/mpu/mcp-token)"
HELPER

hook_claude_mcp() {
  local want file=$HOME/.claude.json
  want=$(jq -cn --arg url "$mcp_url/mcp" --arg helper "$claude_helper" \
    '{type: "http", url: $url, headersHelper: $helper}') || fail "claude mcp" "запись не собрана"
  if jq -e --argjson want "$want" '.mcpServers.mpu == $want' "$file" >/dev/null 2>&1; then
    say "claude mcp: без изменений"
    return
  fi
  if jq -e '.mcpServers.mpu' "$file" >/dev/null 2>&1; then
    "$claude" mcp remove --scope user mpu >/dev/null || fail "claude mcp" "прежний сервер mpu не снят"
  fi
  "$claude" mcp add-json --scope user mpu "$want" >/dev/null || fail "claude mcp" "сервер mpu не добавлен"
  say "claude mcp: подключено"
}

# Файла нет — как пустой объект. Ссылка — пишется то, на что она
# смотрит, как у файлов оболочек.
hook_claude_rules() {
  local file=$HOME/.claude/settings.json target current merged
  mkdir -p "$HOME/.claude" || fail "claude права" "нет каталога $HOME/.claude"
  target=$(readlink -f "$file") || fail "claude права" "путь $file не разрешён"
  current='{}'
  if [[ -s $target ]]; then
    current=$(cat "$target") || fail "claude права" "$file не прочитан"
  fi
  merged=$(jq --argjson allow "$claude_allow" --argjson ask "$claude_ask" \
    --argjson deny "$claude_deny" '
    .permissions.allow = ((.permissions.allow // []) + ($allow - (.permissions.allow // [])))
    | .permissions.ask = ((.permissions.ask // []) + ($ask - (.permissions.ask // [])))
    | .permissions.deny = ((.permissions.deny // []) + ($deny - (.permissions.deny // [])))' \
    <<<"$current" 2>/dev/null) || fail "claude права" "$file не JSON"
  if [[ $(jq -S . <<<"$current") == "$(jq -S . <<<"$merged")" ]]; then
    say "claude права: без изменений"
    return
  fi
  printf '%s\n' "$merged" >"$target.mpu-install" &&
    mv -f "$target.mpu-install" "$target" || fail "claude права" "$file не записан"
  say "claude права: вписано"
}

if ! command -v "$claude" >/dev/null; then
  say "claude: не установлен"
else
  command -v jq >/dev/null || fail "claude" "нет jq"
  hook_claude_mcp
  hook_claude_rules
fi

say "готово"
