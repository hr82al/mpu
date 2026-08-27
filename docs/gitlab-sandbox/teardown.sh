#!/usr/bin/env bash
# Полное удаление песочницы GitLab: контейнер, тома с данными, сеть, образ и
# конфиг-каталог `mpu`, которым в неё ходили. После этого на машине не остаётся
# ничего, кроме этого каталога со скриптами — он и есть рецепт поднять заново.
#
#   bash teardown.sh          # снести всё, включая образ (≈5.4 ГБ)
#   bash teardown.sh --keep-image   # оставить образ, чтобы не качать снова
set -euo pipefail

cd "$(dirname "$0")"

echo "— останавливаю и удаляю контейнер вместе с томами"
docker compose down --volumes --remove-orphans

if [[ "${1:-}" != "--keep-image" ]]; then
  echo "— удаляю образ"
  docker image rm gitlab/gitlab-ce:latest || true
fi

echo "— удаляю конфиг-каталог песочницы (токен и адрес)"
rm -rf ./config

echo "— что осталось от песочницы в docker:"
docker ps -a --filter name=mpu-gitlab-sandbox --format '  контейнер: {{.Names}}' || true
docker volume ls --filter name=gitlab-sandbox --format '  том: {{.Name}}' || true
docker images --format '  образ: {{.Repository}}:{{.Tag}}' | grep gitlab || echo "  образов gitlab нет"

echo "готово; поднять заново — bash setup.sh"
