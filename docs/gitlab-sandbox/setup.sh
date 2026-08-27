#!/usr/bin/env bash
# Поднять песочницу GitLab с нуля и посеять в неё проект с MR под парные
# прогоны `mpu mr`. Идемпотентен: повторный запуск ничего не ломает.
#
#   bash setup.sh
#
# По завершении печатает путь конфиг-каталога, который надо подставлять
# вызовам mpu:  XDG_CONFIG_HOME=<каталог> mpu mr view --mr <project>!<iid>
set -euo pipefail

cd "$(dirname "$0")"
TOKEN_VALUE="mpu-sandbox-token-0000000001"

echo "— поднимаю контейнер"
docker compose up -d

echo "— жду готовности (первый старт занимает минуты)"
# Ждём именно ответа по HTTP, а не health-статуса: healthy он выставляет
# раньше, чем поднимается nginx, и на первом старте успевает даже упасть
# после этого — на посеве администратора.
until curl -s -o /dev/null http://127.0.0.1:8929/users/sign_in; do
  if ! docker ps -q -f name=mpu-gitlab-sandbox | grep -q .; then
    echo "контейнер остановился на старте — смотри docker logs mpu-gitlab-sandbox" >&2
    exit 1
  fi
  sleep 20
done

echo "— создаю токен доступа внутри контейнера"
docker exec mpu-gitlab-sandbox gitlab-rails runner "
  user = User.find_by_username('root')
  user.personal_access_tokens.where(name: 'mpu-sandbox').delete_all
  token = user.personal_access_tokens.create!(
    scopes: ['api'], name: 'mpu-sandbox', expires_at: 365.days.from_now)
  token.set_token('${TOKEN_VALUE}')
  token.save!
" >/dev/null

echo "— готовлю конфиг-каталог песочницы"
mkdir -p ./config/mpu
cat > ./config/mpu/.env <<ENV
# Только песочница: боевые ключи сюда не копируются.
GLAB_TOKEN=${TOKEN_VALUE}
GITLAB_BASE_URL=http://127.0.0.1:8929
ENV
chmod 600 ./config/mpu/.env

echo "— сею проект, ветку и MR"
python3 seed.py "${TOKEN_VALUE}" | tee ./seed.json

echo
echo "конфиг-каталог: $(pwd)/config"
echo "пример вызова:  XDG_CONFIG_HOME=$(pwd)/config mpu mr view --mr root/mpu-sandbox!1"
