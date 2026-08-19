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
  // Тип значения — строка, а не число: спека требует от `--skus`
  // единственного — уехать одним скобочным литералом. Ограничение
  // «только цифры» не её правило, а наша догадка о нижестоящем парсере,
  // и оно ломало бы контрактный обход реестра, который подставляет
  // каждому строковому входу короткую строку.
  skus: z.array(z.string()).optional().describe(
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
  summary: "Пересчитать расходы Ozon UNIT клиента за период.",
  usage:
    "mpu ozon-recalculate-expenses SELECTOR [--server sl-N] [-p [--local]] [--client-id N] [--date-from F] [--date-to T] [--ref-date D] [--ref-fields F]… [--skus SKU]… [--logs-level L] [-v]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:ozonUnitCalculatedData recalculateExpenses\`
и стримит его вывод, код выхода наследуется 1:1. Пересчёт перезаписывает
расчётные данные UNIT клиента за указанный период.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода. -v/--verbose печатает
собранную inner-команду строкой \`# inner: …\` в stderr — во всех трёх
режимах, не подменяя обычный вывод.

Период: --date-from по умолчанию 2025-01-01, --date-to — сегодняшняя
дата машины (вычисляется в момент вызова и всегда уходит в команду явно).
--ref-date вместе с --ref-fields копирует значения названных полей из
той даты; --ref-fields повторяется (--ref-fields a --ref-fields b).
--skus повторяется и уходит одним токеном [1,2,3].

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--server sl-N задаёт сервер напрямую. --client-id берётся из кандидатов
селектора, если у всех кандидатов он один.

У каждого доменного флага есть snake-написание (--date_from и т. п.).
Значения проверяются до сети и до печати: допустимы только A-Za-z0-9 и
_ . / : - , @ [ ] — пробел или кавычка в значении это ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu ozon-recalculate-expenses 777 --date-from 2026-01-01;
mpu ozon-recalculate-expenses 777 -p -v --skus 123 --ref-date 2026-01-05
--ref-fields sebes_rub`,
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
