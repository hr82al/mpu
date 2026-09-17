/**
 * Команда `mpu ss-datasets` (`docs/specs/portainer-wrappers.md`):
 * регистрация датасета таблицы клиента.
 *
 * В рабочей версии это группа с единственной подкомандой `add`, но
 * typer её схлопывает, и наблюдаемая форма имени подкоманды не
 * содержит. Здесь команда листовая — ровно в наблюдаемой форме
 * (отклонение `preserve` спеки семейства); появится вторая подкоманда
 * — группа вернётся сама.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import {
  commonArgsOf,
  renderWrap,
  resultSchema,
  runWrap,
  targetArgs,
  type WrapIo,
} from "./run.ts";

const argsSchema = z.object({
  ...targetArgs,
  dataset: z.string().describe("датасет: обязателен"),
  "spreadsheet-id": z.string().optional().describe(
    "id таблицы; без него берётся из кандидатов селектора",
  ),
  "sheet-name": z.string().optional().describe("лист таблицы"),
  "is-active": z.boolean().optional().describe(
    "признак активности; --no-is-active в inner-команду не идёт (см. спеку)",
  ),
});

export const ssDatasetsCommand = defineCommand({
  path: ["ss-datasets"],
  summary: "Зарегистрировать датасет таблицы клиента.",
  usage:
    "mpu ss-datasets SELECTOR --dataset D [--server sl-N] [-p [--local]] [--spreadsheet-id S] [--sheet-name N] [--is-active]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:ssDatasets add\` и стримит его вывод, код
выхода наследуется 1:1.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--spreadsheet-id берётся из кандидатов селектора, если у всех
кандидатов он один. --client-id этой команде не нужен: датасет
адресуется таблицей.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка это ошибка ввода.

--dataset обязателен. --is-active уходит голым флагом. Выключить
признак нельзя: --no-is-active в inner-команду не попадает вовсе —
поведение рабочей версии, сохранено намеренно до проверки контракта
метода (спека семейства, «Открытые вопросы»).

Имени подкоманды у команды нет: в рабочей версии группа с единственной
подкомандой схлопнута, и форма без имени — та, которой пользуются.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu ss-datasets 777 --dataset wb_unit --sheet-name UNIT;
mpu ss-datasets 777 --dataset wb_unit --is-active -p`,
  policy: "rw",
  helpWhenBare: true,
  argsSchema,
  forms: { selector: { positional: "one" }, print: { short: "p" } },
  resultSchema,
  run: (args, io: WrapIo) =>
    runWrap(
      {
        service: "ssDatasets",
        method: "add",
        // Датасет адресуется таблицей: `--client-id` у метода нет.
        clientId: "none",
        flags: (context) => [
          {
            name: "spreadsheet-id",
            value: args["spreadsheet-id"] ??
              context.pick("--spreadsheet-id", (c) => c.spreadsheetId),
          },
          { name: "dataset", value: args.dataset },
          { name: "sheet-name", value: args["sheet-name"] },
          // `false` эмиссия семейства выбрасывает наравне с `None`:
          // выключить признак командой нельзя, и это сохранённое
          // поведение оригинала, а не забытая ветка.
          { name: "is-active", value: args["is-active"] },
        ],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});
