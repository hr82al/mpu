/**
 * Команда `mpu ozon-recalculate-expenses`
 * (`docs/specs/portainer-wrappers.md`): пересчёт расходов Ozon UNIT за
 * период. Машинерия — `platform/portainer.md`, здесь поверхность
 * обёртки.
 *
 * Единственная обёртка семейства с `-v/--verbose` и с двумя обходами
 * квирка нижестоящего парсера: `--ref-fields` с одним значением
 * эмитится дважды, а `--skus` — одним скобочным литералом. Оба
 * `preserve` спеки; унифицировать их нельзя.
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
  "ref-date": z.string().optional().describe(
    "дата-источник значений для --ref-fields, YYYY-MM-DD",
  ),
  ref_date: z.string().optional().describe("то же, что --ref-date"),
  "ref-fields": z.array(z.string()).optional().describe(
    "поля, копируемые из --ref-date; флаг повторяется",
  ),
  ref_fields: z.array(z.string()).optional().describe(
    "то же, что --ref-fields",
  ),
  // Целые, как в оригинале: нецифровое значение отвергается разбором
  // ввода — до печати и до сети (спека, «Граничные случаи»). В
  // inner-команде форма от этого не меняется: один токен `[1,2,3]`.
  skus: z.array(z.number().int()).optional().describe(
    "SKU Ozon; флаг повторяется, уходит одним токеном [1,2,3]",
  ),
  "logs-level": z.string().optional().describe("уровень логов пересчёта"),
  logs_level: z.string().optional().describe("то же, что --logs-level"),
  verbose: z.boolean().default(false).describe(
    "напечатать inner-команду в stderr перед доставкой",
  ),
});

export const ozonRecalculateExpensesCommand = defineCommand({
  path: ["ozon-recalculate-expenses"],
  keys: {},
  summary: "Пересчитать расходы Ozon UNIT клиента за период.",
  usage:
    "mpu ozon-recalculate-expenses target: СЕЛЕКТОР [server: sl-N] [--print [--local]] [client-id: N] [date-from: F] [date-to: T] [ref-date: D] [ref-fields: F]… [skus: SKU]… [logs-level: L] [--verbose]",
  help: `Звать, когда расходы Ozon UNIT клиента за период неверны или
устарели и их надо пересчитать.

target: — client_id, spreadsheet_id или заголовок таблицы; server:
sl-N задаёт сервер, client-id: берётся из кандидатов, когда у всех он
один.

По умолчанию ВЫПОЛНЯЕТСЯ в прод-контейнере клиента: запускает
\`node cli service:ozonUnitCalculatedData recalculateExpenses\`, стримит
вывод, код выхода наследует 1:1 и перезаписывает расчётные данные UNIT
клиента за период.

--print не выполняет: печатает ssh-команду и копирует в буфер обмена;
--local вместе с --print даёт форму локального стенда, сам по себе — ошибка
ввода. --verbose печатает команду строкой \`# inner: …\` в stderr во всех трёх
режимах, обычный вывод не подменяя.

Период: date-from: по умолчанию 2025-01-01, date-to: — сегодняшняя
дата (вычисляется в момент вызова). ref-date: с повторяемым
ref-fields: копирует значения этих полей из той даты. skus:
повторяется, уходит токеном [1,2,3]. logs-level: — уровень логов.

Значения проверяются до сети и печати: только A-Za-z0-9 и _ . / : - , @
[ ] — пробел или кавычка это ошибка ввода.

Exit: код inner-команды; 0 при печати; 2 — ввод, резолв, конфигурация.`,
  examples: [
    "mpu ozon-recalculate-expenses target: 777 --print --verbose skus: 123 ref-date: 2026-01-05 ref-fields: sebes_rub",
  ],
  policy: "rw",
  helpWhenBare: true,
  argsSchema,
  forms: {
    selector: { positional: "one" },
    print: { short: "p" },
    verbose: { short: "v" },
  },
  resultSchema,
  run: (args, io: WrapIo) =>
    runWrap(
      {
        service: "ozonUnitCalculatedData",
        method: "recalculateExpenses",
        flags: () => [
          ...periodFlags(args),
          { name: "ref-date", value: args["ref-date"] ?? args.ref_date },
          {
            name: "ref-fields",
            value: refFields(args["ref-fields"] ?? args.ref_fields),
          },
          // Скобочный литерал, а не повторяемый флаг: парсер sl-back CLI
          // распознаёт целочисленный JSON-массив, и эта форма не
          // подвержена схлопыванию (спека, `preserve`).
          {
            name: "skus",
            value: args.skus === undefined || args.skus.length === 0
              ? undefined
              : `[${args.skus.join(",")}]`,
          },
          {
            name: "logs-level",
            value: args["logs-level"] ?? args.logs_level,
          },
        ],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});

/**
 * Единственное значение `--ref-fields` эмитится дважды: парсер sl-back
 * CLI схлопывает одиночное значение повторяемого флага в скаляр, а метод
 * ждёт массив (спека, `preserve`). Дубль безопасен — повторный ключ
 * поглощается при записи.
 */
function refFields(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values.length === 1 ? [values[0], values[0]] : values;
}
