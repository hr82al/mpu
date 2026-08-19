/**
 * Команда `mpu wb-recalculate-expenses`
 * (`docs/specs/portainer-wrappers.md`): пересчёт расходов WB UNIT за
 * период. Машинерия — `platform/portainer.md`, здесь поверхность
 * обёртки.
 */

import { z } from "@zod/zod";
import { defineCommand } from "../command/mod.ts";
import { periodArgs, periodFlags } from "./dates.ts";
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
  ...periodArgs,
  "nm-ids": z.string().optional().describe(
    "артикулы WB одним литералом без пробелов, [1,2,3]",
  ),
  nm_ids: z.string().optional().describe("то же, что --nm-ids"),
});

export const wbRecalculateExpensesCommand = defineCommand({
  path: ["wb-recalculate-expenses"],
  summary: "Пересчитать расходы WB UNIT клиента за период.",
  usage:
    "mpu wb-recalculate-expenses SELECTOR [--server sl-N] [-p [--local]] [--client-id N] [--date-from F] [--date-to T] [--nm-ids [..]]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:wbUnitCalculatedData recalculateExpenses\`
и стримит его вывод, код выхода наследуется 1:1. Пересчёт перезаписывает
расчётные данные UNIT клиента за указанный период.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

Период: --date-from по умолчанию 2025-01-01, --date-to — сегодняшняя
дата машины (вычисляется в момент вызова и всегда уходит в команду явно).
--nm-ids — одна строка вида [1,2,3] без пробелов.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--server sl-N задаёт сервер напрямую. --client-id берётся из кандидатов
селектора, если у всех кандидатов он один.

У каждого доменного флага есть snake-написание (--date_from и т. п.).
Значения проверяются до сети и до печати: допустимы только A-Za-z0-9 и
_ . / : - , @ [ ] — пробел или кавычка в значении это ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu wb-recalculate-expenses 777 --date-from 2026-01-01;
mpu wb-recalculate-expenses 777 -p --nm-ids [1,2,3]`,
  policy: "rw",
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
        service: "wbUnitCalculatedData",
        method: "recalculateExpenses",
        flags: () => [
          ...periodFlags(args),
          { name: "nm-ids", value: args["nm-ids"] ?? args.nm_ids },
        ],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});
