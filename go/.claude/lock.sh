#!/usr/bin/env bash
# Тумблер доступа Claude к .claude/settings.json.
#
#   lock.sh on      запретить редактирование (правило в deny)
#   lock.sh off     разрешить редактирование
#   lock.sh status  показать текущее состояние
#
# Запускать ТОЛЬКО из внешнего терминала — внутри сессии Claude Code (в т.ч.
# через `!`) каталог .claude read-only, и запись упадёт с Errno 30.
#
# Чтение настроек не затрагивается ни в одном состоянии — закрывается только запись.
set -euo pipefail

RULE='Edit(//home/user/mr/mp/mpu/go/.claude/**)'
SETTINGS="${CC_SETTINGS:-/home/user/mr/mp/mpu/go/.claude/settings.json}"

[[ -f "$SETTINGS" ]] || { echo "не найден: $SETTINGS" >&2; exit 1; }

has_rule() {
  python3 - "$SETTINGS" "$RULE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if sys.argv[2] in d.get('permissions', {}).get('deny', []) else 1)
PY
}

set_rule() {
  python3 - "$SETTINGS" "$RULE" "$1" <<'PY'
import json, sys
path, rule, want = sys.argv[1], sys.argv[2], sys.argv[3] == 'on'
d = json.load(open(path))
deny = d.setdefault('permissions', {}).setdefault('deny', [])
if want and rule not in deny:
    deny.append(rule)
elif not want and rule in deny:
    deny.remove(rule)
with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')
PY
}

case "${1:-}" in
  on|off)
    set_rule "$1"
    ;;
  status)
    ;;
  *)
    echo "использование: $(basename "$0") on|off|status" >&2
    exit 2
    ;;
esac

if has_rule; then
  echo "settings.json: ЗАПЕРТ (Claude читает, но не пишет)"
else
  echo "settings.json: ОТКРЫТ (Claude может править)"
fi
