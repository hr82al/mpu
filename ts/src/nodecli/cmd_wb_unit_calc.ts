/**
 * Команда `mpu wb-unit-calc` (`docs/specs/portainer-wrappers.md`):
 * расчётные данные WB UNIT по товару за дату.
 *
 * Листовая по той же причине, что `ss-datasets`: в рабочей версии это
 * группа с единственной подкомандой, схлопнутая typer'ом, и наблюдаемая
 * форма имени подкоманды не содержит.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { today } from "../dates/mod.ts";
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
  "nm-id": z.string().describe("товар WB: nmId, обязателен"),
  date: z.string().optional().describe(
    "дата расчёта; по умолчанию сегодняшняя, эмитится всегда",
  ),
});

export const wbUnitCalcCommand = defineCommand({
  path: ["wb-unit-calc"],
  summary: "Показать расчётные данные WB UNIT по товару за дату.",
  usage:
    "mpu wb-unit-calc SELECTOR --nm-id N [--server sl-N] [-p [--local]] [--client-id N] [--date YYYY-MM-DD]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:wbUnitCalc getUnitDataByDateNmId\` и стримит
его вывод, код выхода наследуется 1:1.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--client-id берётся из кандидатов селектора, если у всех кандидатов он
один.

--nm-id обязателен. --date по умолчанию сегодняшний локальный день и
уходит в inner-команду всегда явным токеном — чтобы напечатанную
команду можно было вставить в чужой терминал завтра и получить тот же
день, что виден в строке.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка это ошибка ввода.

Имени подкоманды у команды нет: в рабочей версии группа с единственной
подкомандой схлопнута.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu wb-unit-calc 777 --nm-id 123;
mpu wb-unit-calc 777 --nm-id 123 --date 2026-08-01 -p`,
  policy: "rw",
  helpWhenBare: true,
  argsSchema,
  forms: { selector: { positional: "one" }, print: { short: "p" } },
  resultSchema,
  run: (args, io: WrapIo) =>
    runWrap(
      {
        service: "wbUnitCalc",
        method: "getUnitDataByDateNmId",
        flags: () => [
          { name: "nm-id", value: args["nm-id"] },
          // Дефолт вычисляется в момент вызова и всегда виден в
          // строке: инвариант семейства про даты.
          { name: "date", value: args.date ?? today() },
        ],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});
