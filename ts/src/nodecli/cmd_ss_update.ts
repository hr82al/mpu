/**
 * Команда `mpu ss-update` (`docs/specs/portainer-wrappers.md`): запуск
 * пайплайна обновления Google-таблицы клиента. Машинерия —
 * `platform/portainer.md`, здесь поверхность обёртки.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import {
  commonArgs,
  commonArgsOf,
  renderWrap,
  resultSchema,
  runWrap,
  type WrapIo,
} from "./run.ts";

const argsSchema = z.object({
  ...commonArgs,
  "spreadsheet-id": z.string().optional().describe(
    "id таблицы; без него берётся из кандидатов селектора",
  ),
  spreadsheet_id: z.string().optional().describe(
    "то же, что --spreadsheet-id",
  ),
  "update-type": z.string().optional().describe("тип обновления"),
  update_type: z.string().optional().describe("то же, что --update-type"),
  logs: z.string().default("info").describe("уровень логов пайплайна"),
});

export const ssUpdateCommand = defineCommand({
  path: ["ss-update"],
  // Однострока — из слепка дерева, но с поправкой отклонения `fix`:
  // дефолт у обёртки — выполнение, а не печать.
  summary: "Запустить обновление Google-таблицы клиента в контейнере sl-back.",
  usage:
    "mpu ss-update SELECTOR [--server sl-N] [-p [--local]] [--client-id N] [--spreadsheet-id S] [--update-type T] [--logs L]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:ssUpdater update\` и стримит его вывод, код
выхода наследуется 1:1.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--server sl-N задаёт сервер напрямую. --client-id и --spreadsheet-id
берутся из кандидатов селектора, если у всех кандидатов значение одно;
иначе задайте их флагом.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка в значении это
ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu ss-update 777; mpu ss-update 777 -p; mpu ss-update 777 -p
--local --update-type manual`,
  policy: "rw",
  // Голый вызов печатает справку, а не сообщение схемы (спека
  // семейства, «CLI-контракт»).
  helpWhenBare: true,
  argsSchema,
  forms: {
    selector: { positional: "one" },
    print: { short: "p" },
  },
  resultSchema,
  run: (args, io: WrapIo) =>
    runWrap(
      {
        service: "ssUpdater",
        method: "update",
        flags: (context) => [
          {
            name: "spreadsheet-id",
            value: args["spreadsheet-id"] ?? args.spreadsheet_id ??
              context.pick("--spreadsheet-id", (c) => c.spreadsheetId),
          },
          {
            // Порядок один у обоих алиасов: kebab первым, дефолт —
            // после обоих написаний (спека семейства).
            name: "update-type",
            value: args["update-type"] ?? args.update_type ?? "schedule",
          },
          { name: "logs", value: args.logs },
        ],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  // Код inner-команды не подменяется (инвариант спеки).
  textExitCode: (result) => result.exitCode,
});
