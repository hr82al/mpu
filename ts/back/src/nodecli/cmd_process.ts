/**
 * Команда `mpu process` (`docs/specs/portainer-wrappers.md`): пересчёт
 * витрин клиента через `dataProcessor.process`. Самая широкая обёртка
 * семейства — двадцать доменных флагов и три разных правила для
 * списков.
 *
 * Правила списков не унифицируются: каждое обходит свой квирк парсера
 * sl-back CLI, и общий вид у них только внешний (спека семейства,
 * «Известные отклонения»).
 */

import { z } from "@zod/zod";
import { defineCommand, UsageError } from "../command/mod.ts";
import type { Flag } from "./inner.ts";
import {
  commonArgs,
  commonArgsOf,
  renderWrap,
  resultSchema,
  runWrap,
  type WrapIo,
} from "./run.ts";

/** Селектор dev-ноды: `dev:N`, где N — номер sl-сервера. */
const DEV = /^dev:(.*)$/;

const argsSchema = z.object({
  ...commonArgs,
  "spreadsheet-id": z.string().optional().describe(
    "id таблицы; без него берётся из кандидатов, если он там один",
  ),
  "date-from": z.string().optional().describe("начало периода, YYYY-MM-DD"),
  "date-to": z.string().optional().describe("конец периода, YYYY-MM-DD"),
  domain: z.string().optional().describe("площадка: wb либо ozon"),
  dataset: z.string().optional().describe("один датасет; строка, не список"),
  datasets: z.array(z.string()).optional().describe(
    "датасеты; флаг повторяется",
  ),
  modules: z.array(z.string()).optional().describe("модули; флаг повторяется"),
  "exclude-datasets": z.array(z.string()).optional().describe(
    "датасеты-исключения; флаг повторяется",
  ),
  "exclude-modules": z.array(z.string()).optional().describe(
    "модули-исключения; флаг повторяется",
  ),
  "with-tags": z.array(z.string()).optional().describe(
    "теги-фильтры; флаг повторяется",
  ),
  "without-tags": z.array(z.string()).optional().describe(
    "теги-исключения; флаг повторяется",
  ),
  "no-deps": z.boolean().default(false).describe("не тянуть зависимости"),
  forced: z.boolean().default(false).describe("пересчитать принудительно"),
  "forced-update": z.boolean().default(false).describe(
    "принудительно обновить витрины",
  ),
  "dry-run": z.boolean().default(false).describe(
    "прогон метода вхолостую; это флаг метода, а не режим печати",
  ),
  sid: z.string().optional().describe("WB-кабинет: sid"),
  "nm-ids": z.string().optional().describe(
    "товары WB одной строкой вида [1,2] без пробелов",
  ),
  skus: z.array(z.number().int()).optional().describe(
    "SKU Ozon; флаг повторяется, уходит одним токеном [1,2]",
  ),
  logs: z.string().optional().describe("уровень логов пересчёта"),
  verbose: z.boolean().default(false).describe(
    "напечатать inner-команду в stderr перед доставкой",
  ),
});

type ProcessArgs = z.infer<typeof argsSchema>;

export const processCommand = defineCommand({
  path: ["process"],
  summary: "Пересчитать витрины клиента (dataProcessor.process).",
  usage:
    "mpu process SELECTOR [--server sl-N] [-p [--local]] [--client-id N] [--dataset D] [--datasets D…] [--modules M…] [--with-tags T…] [--forced] [--dry-run] [--skus SKU]… [--logs L] [-v]",
  help: `По умолчанию ВЫПОЛНЯЕТСЯ в прод-контейнере клиента: запускает
\`node cli service:dataProcessor process\`, стримит вывод, наследует код
выхода 1:1 и пересчитывает витрины клиента.

-p/--print печатает команду и копирует её в буфер, не выполняя;
--local вместе с -p — форма локального стенда. --dry-run к печати
отношения не имеет: это флаг метода.

SELECTOR — client_id, spreadsheet_id, заголовок либо dev:N.
--client-id и --spreadsheet-id берутся из кандидатов, если значение там
одно; неоднозначный --spreadsheet-id не ошибка — флаг не эмитится.
dev:N идёт мимо резолва (кэша клиентов на dev-ноде нет): там
--client-id обязателен, а печать даёт mpu ssh dev:N -- <inner>.

Три правила списков: --datasets, --modules, --exclude-datasets,
--exclude-modules, --with-tags, --without-tags уходят одним флагом со
значениями подряд, а единственное значение ДУБЛИРУЕТСЯ (--datasets
wb_unit → --datasets wb_unit wb_unit); --skus повторяется у оператора и
уходит одним токеном [1,2]; --nm-ids приходит строкой [7,8] как есть.
--dataset — обычная строка.

-v печатает # inner: <команда> в stderr во всех режимах. Значения
проверяются до сети: допустимы A-Za-z0-9 и _ . / : - , @ [ ].

Exit: код inner-команды; 0 при печати; 2 — ошибки ввода и резолва.

Пример: mpu process 777 --dataset wb_unit -p`,
  policy: "rw",
  helpWhenBare: true,
  argsSchema,
  forms: {
    selector: { positional: "one" },
    print: { short: "p" },
    verbose: { short: "v" },
  },
  resultSchema,
  run: (args: ProcessArgs, io: WrapIo) =>
    runWrap(
      {
        service: "dataProcessor",
        method: "process",
        flags: (context): readonly Flag[] => [
          {
            name: "spreadsheet-id",
            value: args["spreadsheet-id"] ??
              context.pickOrNone((candidate) => candidate.spreadsheetId),
          },
          { name: "date-from", value: args["date-from"] },
          { name: "date-to", value: args["date-to"] },
          { name: "domain", value: args.domain },
          { name: "dataset", value: args.dataset },
          { name: "datasets", value: stringList(args.datasets) },
          { name: "modules", value: stringList(args.modules) },
          {
            name: "exclude-datasets",
            value: stringList(args["exclude-datasets"]),
          },
          {
            name: "exclude-modules",
            value: stringList(args["exclude-modules"]),
          },
          { name: "with-tags", value: stringList(args["with-tags"]) },
          { name: "without-tags", value: stringList(args["without-tags"]) },
          { name: "no-deps", value: flagIfSet(args["no-deps"]) },
          { name: "forced", value: flagIfSet(args.forced) },
          { name: "forced-update", value: flagIfSet(args["forced-update"]) },
          { name: "dry-run", value: flagIfSet(args["dry-run"]) },
          { name: "sid", value: args.sid },
          { name: "nm-ids", value: args["nm-ids"] },
          { name: "skus", value: skusToken(args.skus) },
          { name: "logs", value: args.logs },
        ],
      },
      { ...commonArgsOf(args), devServerNumber: devServerOf(args.selector) },
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});

/**
 * Номер сервера dev-ноды, если селектор её называет. Нечисловой хвост
 * — ошибка ввода: `dev:` без номера адресует несуществующий контейнер,
 * и узнать об этом лучше до сети.
 */
function devServerOf(selector: string): number | undefined {
  const match = DEV.exec(selector.trim());
  if (match === null) return undefined;
  if (!/^\d+$/.test(match[1])) {
    throw new UsageError(
      "dev-селектор ожидает номер sl-сервера: `dev:N` (например dev:1)",
    );
  }
  return Number(match[1]);
}

/**
 * Строковый список: флаг один раз, значения подряд — но единственное
 * значение дублируется. Парсер sl-back CLI схлопывает одиночное
 * значение повторяемого флага в скаляр, а потребитель идёт по нему
 * циклом и получает буквы вместо элементов; для Set-семантики дубль
 * равнозначен одному значению (спека, `preserve`).
 */
function stringList(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values.length === 1 ? [values[0], values[0]] : values;
}

/**
 * SKU одним скобочным литералом: целочисленный JSON-массив парсер
 * распознаёт, и схлопыванию эта форма не подвержена (спека,
 * `preserve`). Третье правило списка — и третий обход того же квирка.
 */
function skusToken(values: readonly number[] | undefined): string | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return `[${values.join(",")}]`;
}

/** Голый флаг: `false` следа не оставляет, `true` идёт без значения. */
function flagIfSet(value: boolean): true | undefined {
  return value === true ? true : undefined;
}
