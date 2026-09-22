#!/usr/bin/env bash
# ВРЕМЕННЫЙ скрипт: живёт до порции 15b, когда на машинах не останется
# старой установки, и уходит вместе с ней.
#
# Уборка старого перед переключением имён
# (docs/specs/platform/cutover.md, «ts/cutover.sh»): гасит и снимает
# mpu-mcp.service и mpu-next.service, удаляет ~/.local/bin/mpu-next и
# последним шагом зовёт ./install.sh с теми же аргументами. Нужна ровно
# один раз на машине, поэтому живёт отдельно от установщика.
#
#   ./cutover.sh [--check] [прочие аргументы установщика]
#
# Переопределения окружением — для тестов: MPU_BIN_DIR, MPU_UNIT_DIR,
# MPU_SYSTEMCTL.
set -uo pipefail

# Дерево исходников — каталог самого скрипта, а не текущий: скрипт зовут
# откуда придётся и бывает, что по символической ссылке. Ни один путь
# ниже не берётся от $PWD (`platform/cutover.md`).
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
bin_dir=${MPU_BIN_DIR:-$HOME/.local/bin}
unit_dir=${MPU_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
systemctl=${MPU_SYSTEMCTL:-systemctl}

say() { printf 'cutover: %s\n' "$*"; }
fail() { say "$1: ошибка: $2"; exit 1; }

check=0
for arg in "$@"; do
  [[ $arg == --check ]] && check=1
done

# Старая служба: погасить, выключить, снять файл, перечитать. Её нет —
# это обычный исход, а не ошибка: скрипт запускают и на чистой машине.
retire_unit() {
  local unit=$1 name=${1%.service}
  if [[ ! -e $unit_dir/$unit ]]; then
    say "$unit: нечего убирать"
    return
  fi
  if ((check)); then
    say "$unit: есть, будет снята"
    return
  fi
  # Открытый процесс переживает удаление файла службы (ядро держит
  # inode), поэтому гасится явно.
  "$systemctl" --user stop "$name" || fail "$unit" "stop"
  "$systemctl" --user disable "$name" || fail "$unit" "disable"
  rm -f "$unit_dir/$unit" || fail "$unit" "файл не удалён"
  "$systemctl" --user daemon-reload || fail "$unit" "daemon-reload"
  say "$unit: снята"
}

# Программа времени стройки: забытая, она сравнивалась бы установщиком
# сама с собой и вечно звалась «без изменений».
retire_program() {
  local program=$1
  if [[ ! -e $bin_dir/$program ]]; then
    say "$program: нечего убирать"
    return
  fi
  if ((check)); then
    say "$program: есть, будет удалён"
    return
  fi
  rm -f "$bin_dir/$program" || fail "$program" "не удалён"
  say "$program: удалён"
}

retire_unit mpu-mcp.service
retire_unit mpu-next.service
retire_program mpu-next

if ((check)); then
  say "готово"
  exit 0
fi

# Переключение — одно действие, а не два, которые человек обязан не
# перепутать местами.
say "установка: запускается"
exec "$here/install.sh" "$@"
