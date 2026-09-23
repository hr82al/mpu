#!/bin/sh
# Исполнитель строк из исходников (`platform/line-executor.md`): у
# `deno task back` рядом с `deno` программы `mpu-worker` нет, и ядро
# получает этот путь флагом `--worker`. Права — у задачи `worker`.
cd "$(dirname "$0")/../.." && exec deno task -q worker "$@"
