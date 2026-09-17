/**
 * Группы `mpu wb-jobs`, `mpu data-loader-jobs`, `mpu ozon-jobs`
 * (`docs/specs/portainer-wrappers.md`): очереди задач загрузчиков на
 * сервере. Отличаются сервисом sl-back CLI и составом подкоманд,
 * поэтому объявляются одной сборкой.
 *
 * Раскладка argv у всех трёх — `selector-first`: селектор и режимы
 * печати набираются до имени подкоманды (признак объявлен у группы в
 * реестре). Обёртке это безразлично — ей достаётся тот же argv, что и
 * соседям семейства.
 */

import { z } from "@zod/zod";
import { type Command, defineCommand } from "../command/mod.ts";
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
  pattern: z.string().optional().describe(
    "отбор задач по имени; незаданный флаг в inner-команду не идёт",
  ),
});

/** Подкоманда → метод сервиса и её однострока. */
const SUBCOMMANDS: Readonly<Record<string, readonly [string, string]>> = {
  show: ["showJobs", "показать очередь задач"],
  prune: ["pruneJobs", "вычистить очередь задач"],
};

/** Группа очередей: имя, сервис sl-back CLI, состав и о чём она. */
interface JobsGroup {
  readonly group: string;
  readonly service: string;
  readonly subs: readonly string[];
  readonly what: string;
  /** Образец `--pattern` для справки: из домена самой группы. */
  readonly sample: string;
}

const GROUPS: readonly JobsGroup[] = [
  {
    group: "wb-jobs",
    service: "wbJobs",
    subs: ["show"],
    what: "WB-загрузчика",
    sample: "wbCards",
  },
  {
    group: "data-loader-jobs",
    service: "dataLoaderJobs",
    subs: ["show"],
    what: "загрузчика данных",
    sample: "dataLoader",
  },
  {
    group: "ozon-jobs",
    service: "ozonJobs",
    subs: ["show", "prune"],
    what: "Ozon-загрузчика",
    sample: "ozonLoader",
  },
];

/** Все подкоманды трёх групп в порядке объявления. */
export const jobsCommands: readonly Command[] = GROUPS.flatMap((group) =>
  group.subs.map((sub) => jobs(group, sub))
);

function jobs(group: JobsGroup, sub: string): Command {
  const [method, what] = SUBCOMMANDS[sub];
  return defineCommand({
    path: [group.group, sub],
    summary: `Очередь задач ${group.what}: ${what}.`,
    usage: `mpu ${group.group} [-p [--local]] SELECTOR ${sub} [--pattern P]`,
    help: `Селектор и режимы печати набираются ДО имени подкоманды:
mpu ${group.group} sl-2 ${sub}. Имя подкоманды перед селектором — ошибка
ввода: раскладка сохранена от рабочей версии, её набирают руками
каждый день.

По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере сервера: запускает
\`node cli service:${group.service} ${method}\` и стримит его вывод, код
выхода наследуется 1:1.

-p/--print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. --local вместе с -p печатает форму локального стенда
(без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id, заголовок таблицы либо сам сервер
(sl-N); --server sl-N задаёт сервер напрямую. --client-id у этой
команды нет: очередь принадлежит серверу, а не клиенту, и в
inner-команду он не идёт.

--pattern необязателен; незаданный флаг в inner-команде не появляется
вовсе. Значения проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел, кавычка или звёздочка это
ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.

Примеры: mpu ${group.group} sl-2 ${sub};
mpu ${group.group} -p sl-2 ${sub} --pattern ${group.sample}`,
    policy: "rw",
    helpWhenBare: true,
    errorName: group.group,
    argsSchema,
    forms: {
      selector: { positional: "one" },
      print: { short: "p" },
    },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: group.service,
          method,
          // Очередь принадлежит серверу: `--client-id` у метода нет, и
          // кандидаты ради него не спрашиваются.
          clientId: "none",
          flags: () => [{ name: "pattern", value: args.pattern }],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}
