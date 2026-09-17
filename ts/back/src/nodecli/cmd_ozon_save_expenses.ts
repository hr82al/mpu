/**
 * Команда `mpu ozon-save-expenses` (`docs/specs/portainer-wrappers.md`):
 * сохранение расходов Ozon UNIT за период. Машинерия —
 * `platform/portainer.md`, здесь поверхность обёртки.
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
});

export const ozonSaveExpensesCommand = defineCommand({
  path: ["ozon-save-expenses"],
  summary: "Сохранить расходы Ozon UNIT клиента за период.",
  usage:
    "mpu ozon-save-expenses SELECTOR [--server sl-N] [-p [--local]] [--client-id N] [--date-from F] [--date-to T]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:ozonUnitCalculatedData saveExpenses\` и
стримит его вывод, код выхода наследуется 1:1. Сохранение перезаписывает
расчётные данные UNIT клиента за указанный период.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

Период: --date-from по умолчанию 2025-01-01, --date-to — сегодняшняя
дата машины (вычисляется в момент вызова и всегда уходит в команду явно).

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--server sl-N задаёт сервер напрямую. --client-id берётся из кандидатов
селектора, если у всех кандидатов он один.

У каждого доменного флага есть snake-написание (--date_from и т. п.).
Значения проверяются до сети и до печати: допустимы только A-Za-z0-9 и
_ . / : - , @ [ ] — пробел или кавычка в значении это ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu ozon-save-expenses 777 --date-from 2026-01-01;
mpu ozon-save-expenses 777 -p --date-to 2026-01-31`,
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
        service: "ozonUnitCalculatedData",
        method: "saveExpenses",
        flags: () => [
          ...periodFlags(args),
        ],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});
