#!/bin/sh
# Исполнитель строк из исходников (`platform/line-executor.md`): у
# `bun run back` рядом с `bun` программы `mpu-worker` нет, и ядро
# получает этот путь флагом `--worker`.
cd "$(dirname "$0")/../.." && exec bun back/worker.ts "$@"
