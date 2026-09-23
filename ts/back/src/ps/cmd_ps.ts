/**
 * Команда `mpu ps` (`docs/specs/ps.md`): список контейнеров из кэша
 * либо живой с Portainer выбранного сервера.
 */

import { defineCommand } from "../command/mod.ts";
import { renderPs } from "./render.ts";
import { argsSchema, type PsIo, resultSchema, runPs } from "./run.ts";

export const psCommand = defineCommand({
  path: ["ps"],
  keys: {},
  // Однострока — из слепка дерева: её видит режим дополнения.
  summary: "Список Docker-контейнеров (кэш или живой Portainer).",
  usage: "mpu ps [target: СЕЛЕКТОР] [filter: SUBSTR] [end json | end tsv]",
  help: `Звать, когда нужно имя или состояние контейнера: из кэша без сети или
живым списком сервера.

Без селектора — снапшот локального кэша, без сети: данные на
момент последнего \`mpu init\`, колонки ENDPOINT NAME STATE IMAGE. С
селектором (sl-N либо client_id/spreadsheet/title) — живой список с
Portainer этого сервера, колонки NAME STATE STATUS IMAGE.

Колонка STATUS есть только у живого списка: транзиентную строку Docker
кэш не хранит. Расширения селектора \`dev:\` и имя контейнера не
поддерживаются — это не exec-команда.

filter: — буквальная подстрока имени в обоих режимах; ноль
совпадений успех, а не отказ. end json (массив объектов, отступ 2) и
end tsv (колонки через табуляцию, без шапки) взаимоисключающи.

Exit: 0 — успех, включая пустые списки; 1 — ошибка кэш-БД и сетевая
ошибка Portainer; 2 — ошибки ввода, резолва и конфигурации.`,
  examples: [
    "mpu ps",
    "mpu ps filter: wb-loader end tsv",
    "mpu ps target: sl-1",
    "mpu ps target: 42 end json",
  ],
  policy: "ro",
  argsSchema,
  formats: { tsv: ["--tsv"] },
  forms: {
    selector: { positional: "one" },
    filter: { short: "f" },
  },
  resultSchema,
  run: (args, io: PsIo) => runPs(args, io),
  render: (result, args) =>
    renderPs(result, args.json ? "json" : args.tsv ? "tsv" : "table"),
});
