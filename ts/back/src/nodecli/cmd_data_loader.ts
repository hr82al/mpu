/**
 * Команда `mpu data-loader` (`docs/specs/portainer-wrappers.md`): поиск
 * кандидата загрузки данных клиента по кабинетам. Машинерия —
 * `platform/portainer.md`, здесь поверхность обёртки.
 */

import { z } from "@zod/zod";
import { defineCommand, UsageError } from "../command/mod.ts";
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
  sids: z.array(z.string()).optional().describe(
    "кабинеты-кандидаты; флаг повторяется, обязателен",
  ),
  sid: z.array(z.string()).optional().describe("то же, что --sids"),
});

export const dataLoaderCommand = defineCommand({
  path: ["data-loader"],
  summary: "Найти кандидата загрузки данных клиента по кабинетам.",
  usage:
    "mpu data-loader SELECTOR --sids SID… [--server sl-N] [-p [--local]] [--client-id N]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:dataLoader findCandidate\` и стримит его
вывод, код выхода наследуется 1:1.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--server sl-N задаёт сервер напрямую. --client-id берётся из кандидатов
селектора, если у всех кандидатов он один. --sids обязателен, флаг
повторяется (--sids abc --sids def) и никогда не выводится из
кандидатов автоматически; алиас --sid.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка в значении это
ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu data-loader 777 --sids abc --sids def;
mpu data-loader 777 -p --sid abc`,
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
        service: "dataLoader",
        method: "findCandidate",
        flags: () => [{ name: "sids", value: sids(args.sids, args.sid) }],
      },
      commonArgsOf(args),
      io,
    ),
  render: renderWrap,
  textExitCode: (result) => result.exitCode,
});

/** `--sids` обязателен: пустой или отсутствующий список — ошибка ввода. */
function sids(
  primary: readonly string[] | undefined,
  alias: readonly string[] | undefined,
): readonly string[] {
  const value = primary ?? alias;
  if (value === undefined || value.length === 0) {
    throw new UsageError("нужен --sids (повторяемый; алиас --sid)");
  }
  return value;
}
