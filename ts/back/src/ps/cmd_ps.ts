/**
 * Команда `mpu ps` (`docs/specs/ps.md`): список контейнеров из кэша
 * либо живой с Portainer выбранного сервера.
 */

import { defineCommand } from "../command/mod.ts";
import { renderPs } from "./render.ts";
import { argsSchema, type PsIo, resultSchema, runPs } from "./run.ts";

export const psCommand = defineCommand({
  path: ["ps"],
  // Однострока — из слепка дерева: её видит режим дополнения.
  summary: "Список Docker-контейнеров (кэш или живой Portainer).",
  usage: "mpu ps [SELECTOR] [-f SUBSTR] [--json | --tsv]",
  help: `Без селектора — снапшот локального кэша, без сети: данные на
момент последнего \`mpu init\`, колонки ENDPOINT NAME STATE IMAGE. С
селектором (sl-N либо client_id/spreadsheet/title) — живой список с
Portainer этого сервера, колонки NAME STATE STATUS IMAGE.

Колонка STATUS есть только у живого списка: транзиентную строку Docker
кэш не хранит. Расширения селектора \`dev:\` и имя контейнера не
поддерживаются — это не exec-команда.

-f/--filter — буквальная подстрока имени в обоих режимах; ноль
совпадений успех, а не отказ. --json (массив объектов, отступ 2) и
--tsv (колонки через табуляцию, без шапки) взаимоисключающи.

Exit: 0 — успех, включая пустые списки; 1 — ошибка кэш-БД и сетевая
ошибка Portainer; 2 — ошибки ввода, резолва и конфигурации.

Примеры: mpu ps; mpu ps -f wb-loader --tsv; mpu ps sl-1; mpu ps 42 --json`,
  policy: "ro",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    filter: { short: "f" },
  },
  resultSchema,
  run: (args, io: PsIo) => runPs(args, io),
  render: (result, args) =>
    renderPs(result, args.json ? "json" : args.tsv ? "tsv" : "table"),
});
