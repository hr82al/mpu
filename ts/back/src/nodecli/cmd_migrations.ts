/**
 * Группы `mpu app-migrations`, `mpu clients-migrations`,
 * `mpu datasets-migrations` (`docs/specs/portainer-wrappers.md`):
 * миграции схем sl-back. Три группы разъезжаются не набором
 * подкоманд, а тем, чем метод адресуется: приложение — сервером,
 * клиентские схемы — клиентом и типом, датасеты — клиентом и
 * датасетом.
 *
 * Отсюда и раскладка argv: у `app-migrations` селектор стоит до имени
 * подкоманды (`selector-first` у группы в реестре), у двух других —
 * после, как у соседей семейства. Раскладка сохранена от рабочей
 * версии: команды набирают руками каждый день.
 */

import { z } from "@zod/zod";
import { type Command, defineCommand } from "../command/mod.ts";
import type { Flag } from "./inner.ts";
import {
  commonArgs,
  commonArgsOf,
  renderWrap,
  resultSchema,
  runWrap,
  targetArgs,
  type WrapIo,
} from "./run.ts";

/** Общее у всех трёх групп: имя миграции, необязательное. */
const nameArg = {
  name: z.string().optional().describe(
    "имя миграции; незаданный флаг в inner-команду не идёт",
  ),
};

const appArgs = z.object({ ...targetArgs, ...nameArg });

const clientsArgs = z.object({
  ...commonArgs,
  ...nameArg,
  type: z.string().describe("тип клиентской схемы: обязателен"),
  forced: z.boolean().default(false).describe(
    "выполнить принудительно; голый флаг без значения",
  ),
});

const clientsAllArgs = z.object({
  ...targetArgs,
  type: z.string().describe("тип клиентской схемы: обязателен"),
});

const datasetsArgs = z.object({
  ...commonArgs,
  ...nameArg,
  dataset: z.string().describe("датасет: обязателен"),
});

/**
 * Подкоманды миграций: имя метода совпадает с именем подкоманды всюду,
 * кроме `latest-all` — там kebab пришлось бы переводить обратно.
 */
const METHODS: Readonly<Record<string, string>> = { "latest-all": "latestAll" };

const CLIENTS_SUBS = ["latest", "up", "rollback", "down", "init"] as const;
const DATASETS_SUBS = ["latest", "up", "rollback", "down", "list"] as const;

/** Все подкоманды трёх групп в порядке объявления. */
export const migrationsCommands: readonly Command[] = [
  ...["latest", "up"].map(appMigrations),
  ...CLIENTS_SUBS.map(clientsMigrations),
  clientsMigrationsAll(),
  ...DATASETS_SUBS.map(datasetsMigrations),
];

function methodOf(sub: string): string {
  return METHODS[sub] ?? sub;
}

/** Общая часть справки: раскладка, режимы и проверка значений. */
function delivery(group: string, service: string, method: string): string {
  return `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере: запускает
\`node cli service:${service} ${method}\` и стримит его вывод, код выхода
наследуется 1:1. Это мутация прод-схемы, а не отчёт о ней.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка это ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Имя команды в ошибках — имя группы: mpu ${group}.`;
}

function appMigrations(sub: string): Command {
  const method = methodOf(sub);
  return defineCommand({
    path: ["app-migrations", sub],
    summary: `Миграции схемы приложения: ${sub}.`,
    usage: `mpu app-migrations [-p [--local]] SELECTOR ${sub} [--name N]`,
    help: `Селектор и режимы печати набираются ДО имени подкоманды:
mpu app-migrations sl-1 ${sub}. Имя подкоманды перед селектором —
ошибка ввода.

${delivery("app-migrations", "appMigrations", method)}

SELECTOR — сам сервер (sl-N) либо клиент, по которому он находится.
--client-id у этой команды нет: схема приложения одна на сервер.

Пример: mpu app-migrations -p sl-1 ${sub}`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "app-migrations",
    argsSchema: appArgs,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "appMigrations",
          method,
          // Схема приложения одна на сервер: клиента метод не знает.
          clientId: "none",
          flags: () => [{ name: "name", value: args.name }],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}

function clientsMigrations(sub: string): Command {
  const method = methodOf(sub);
  return defineCommand({
    path: ["clients-migrations", sub],
    summary: `Миграции клиентской схемы: ${sub}.`,
    usage:
      `mpu clients-migrations ${sub} SELECTOR --type T [--name N] [--forced] [-p [--local]]`,
    help: `Селектор идёт ПОСЛЕ имени подкоманды — как у mpu wb-loader.

${delivery("clients-migrations", "clientsMigrations", method)}

--type обязателен. --name и --forced необязательны: незаданные в
inner-команде не появляются, а --forced уходит голым флагом без
значения. --client-id берётся из кандидатов селектора, если у всех
кандидатов он один.

Пример: mpu clients-migrations ${sub} 777 --type wb -p`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "clients-migrations",
    argsSchema: clientsArgs,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "clientsMigrations",
          method,
          flags: (): readonly Flag[] => [
            { name: "type", value: args.type },
            { name: "name", value: args.name },
            // `false` следа не оставляет, `true` — голый флаг: значения
            // у него нет ни в одной форме (`inner.ts`).
            { name: "forced", value: args.forced === true ? true : undefined },
          ],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}

function clientsMigrationsAll(): Command {
  return defineCommand({
    path: ["clients-migrations", "latest-all"],
    summary: "Миграции клиентских схем: latest по всем клиентам сервера.",
    usage: "mpu clients-migrations latest-all SELECTOR --type T [-p [--local]]",
    help: `Селектор идёт ПОСЛЕ имени подкоманды и означает сервер:
метод сам разъезжается по всем клиентам, и --client-id у него нет — ни
в CLI, ни в inner-команде.

${delivery("clients-migrations", "clientsMigrations", "latestAll")}

--type обязателен.

Пример: mpu clients-migrations latest-all sl-8 --type wb -p`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "clients-migrations",
    argsSchema: clientsAllArgs,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "clientsMigrations",
          method: "latestAll",
          clientId: "none",
          flags: () => [{ name: "type", value: args.type }],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}

function datasetsMigrations(sub: string): Command {
  const method = methodOf(sub);
  return defineCommand({
    path: ["datasets-migrations", sub],
    summary: `Миграции датасетов клиента: ${sub}.`,
    usage:
      `mpu datasets-migrations ${sub} SELECTOR --dataset D [--name N] [-p [--local]]`,
    help: `Селектор идёт ПОСЛЕ имени подкоманды — как у mpu wb-loader.

${delivery("datasets-migrations", "datasetsMigrations", method)}

--dataset обязателен, --name необязателен. --client-id берётся из
кандидатов селектора, если у всех кандидатов он один.

Пример: mpu datasets-migrations ${sub} 777 --dataset wb_unit -p`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "datasets-migrations",
    argsSchema: datasetsArgs,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "datasetsMigrations",
          method,
          flags: () => [
            { name: "dataset", value: args.dataset },
            { name: "name", value: args.name },
          ],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}
