/**
 * Команда `mpu ss-load` (`docs/specs/portainer-wrappers.md`): загрузка
 * листа Google-таблицы клиента в БД. Машинерия —
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
  dataset: z.string().describe("датасет: обязателен"),
  "spreadsheet-id": z.string().optional().describe(
    "id таблицы; без него берётся из кандидатов селектора",
  ),
  "sheet-name": z.string().optional().describe("лист таблицы"),
  forced: z.boolean().default(false).describe(
    "грузить принудительно; голый флаг без значения",
  ),
  logs: z.string().default("info").describe("уровень логов загрузки"),
});

export const ssLoadCommand = defineCommand({
  path: ["ss-load"],
  summary: "Загрузить лист Google-таблицы клиента в БД.",
  usage:
    "mpu ss-load SELECTOR --dataset D [--server sl-N] [-p [--local]] [--client-id N] [--spreadsheet-id S] [--sheet-name N] [--forced] [--logs L]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:ssLoader load\` и стримит его вывод, код
выхода наследуется 1:1. Это запись в БД клиента, а не отчёт о ней.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--server sl-N задаёт сервер напрямую. --client-id и --spreadsheet-id
берутся из кандидатов селектора, если у всех кандидатов значение одно;
иначе задайте их флагом.

--dataset обязателен. --logs эмитится всегда, по умолчанию info.
--forced уходит голым флагом без значения; незаданные --sheet-name и
--forced следа в inner-команде не оставляют.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка это ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu ss-load 777 --dataset wb_unit --sheet-name UNIT;
mpu ss-load 777 --dataset wb_unit -p`,
  policy: "rw",
  helpWhenBare: true,
  argsSchema,
  forms: { selector: { positional: "one" }, print: { short: "p" } },
  resultSchema,
  run: (args, io: WrapIo) =>
    runWrap(
      {
        service: "ssLoader",
        method: "load",
        // Порядок флагов у метода начинается не с `--client-id`, и
        // порядок — контракт нижестоящего парсера, не наш выбор.
        clientId: "placed",
        flags: (context) => [
          { name: "dataset", value: args.dataset },
          { name: "client-id", value: context.clientId },
          {
            name: "spreadsheet-id",
            value: args["spreadsheet-id"] ??
              context.pick("--spreadsheet-id", (c) => c.spreadsheetId),
          },
          { name: "sheet-name", value: args["sheet-name"] },
          { name: "forced", value: args.forced === true ? true : undefined },
          { name: "logs", value: args.logs },
        ],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});
