/**
 * Команда `mpu mp-clone` (`docs/specs/mp-clone.md`): развернуть рабочую
 * область `mp` из GitLab — склонировать недостающие субрепо, не трогая
 * существующие.
 *
 * Сначала план: probe'ы каталогов и сервера строят шаг на каждый
 * субрепо, и ни одной записи до конца плана нет — ошибка сети посреди
 * списка не оставляет полуразвёрнутой области. Затем план печатается
 * (`dry`) или исполняется: это две реализации одного хода, а не флаг
 * внутри шагов.
 */

import { z } from "zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import {
  type Clock,
  type Disk,
  type Shell,
  systemClock,
  systemDisk,
  systemShell,
} from "./ports.ts";
import { CloneStop, Remote, urlOf } from "./remote.ts";
import {
  Fresh,
  headOf,
  NotOnServer,
  OverDummy,
  Present,
  type Step,
  type StepContext,
  Tally,
} from "./steps.ts";
import { SERVICE_REPOS, Workspace } from "./workspace.ts";

const argsSchema = z.object({
  "dry-run": z
    .boolean()
    .default(false)
    .describe("напечатать план, не клонируя и не записывая"),
});

const resultSchema = z.object({
  summary: z
    .string()
    .describe(
      "итог `mp-clone: N склонировано, M уже было, K нет на сервере`; " +
        "пусто — команда остановилась",
    ),
  dryRun: z.boolean(),
  exitCode: z
    .number()
    .int()
    .describe(
      "0 — область готова; 1 — упал git; 3 — ключа GitLab нет в known_hosts",
    ),
});

type MpCloneArgs = z.infer<typeof argsSchema>;
type MpCloneResult = z.infer<typeof resultSchema>;

/** Срез порта: `HOME` и печать служебных строк. */
export type MpCloneIo = Pick<CommandIo, "env" | "progress">;

/** Подстановки для тестов: живых git и ssh у них нет. */
export interface MpCloneOptions {
  readonly shell?: Shell;
  readonly disk?: Disk;
  readonly clock?: Clock;
}

/** Ход вызова: план, затем печать или исполнение. */
export async function runMpClone(
  args: MpCloneArgs,
  io: MpCloneIo,
  options: MpCloneOptions = {},
): Promise<MpCloneResult> {
  const home = io.env("HOME");
  if (home === undefined || home === "") {
    throw new UsageError("корень mp не найден: HOME не задан");
  }
  const disk = options.disk ?? systemDisk;
  const context: StepContext = {
    shell: options.shell ?? systemShell,
    disk,
    workspace: Workspace.open(home, disk),
    backupDir: `${home}/tmp/mp-clone-backup/${(
      options.clock ?? systemClock
    ).stamp()}`,
    say: io.progress,
  };
  const dryRun = args["dry-run"];
  try {
    const steps = await planOf(context);
    const mode = dryRun ? new Printing(context) : new Applying(context);
    return { summary: await walk(context, mode, steps), dryRun, exitCode: 0 };
  } catch (err) {
    if (!(err instanceof CloneStop)) throw err;
    io.progress(`mpu mp-clone: ${err.message}`);
    return { summary: "", dryRun, exitCode: err.exitCode };
  }
}

/** Шаг на каждый субрепо — по состоянию его каталога и сервера. */
async function planOf(context: StepContext): Promise<readonly Step[]> {
  const remote = new Remote(context.shell);
  const steps: Step[] = [];
  for (const name of context.workspace.names()) {
    steps.push(await stepOf(context, remote, name));
  }
  return steps;
}

async function stepOf(
  context: StepContext,
  remote: Remote,
  name: string,
): Promise<Step> {
  const dir = context.workspace.dirOf(name);
  if (!context.disk.exists(dir)) {
    return (await remote.has(name)) ? new Fresh(name) : new NotOnServer(name);
  }
  if (await ownsGit(context, dir)) {
    return new Present(name, await headOf(context.shell, dir));
  }
  return (await remote.has(name))
    ? new OverDummy(name, `${context.backupDir}/${name}`)
    : new NotOnServer(name);
}

/**
 * Свой `.git` у каталога: git отвечает им самим. Пустышка отвечает
 * корнем `mp` либо отказом, если у `mp` своего `.git` нет.
 */
async function ownsGit(context: StepContext, dir: string): Promise<boolean> {
  const top = await context.shell.run([
    "git",
    "-C",
    dir,
    "rev-parse",
    "--show-toplevel",
  ]);
  return top.code === 0 && top.stdout.trim() === context.disk.realPath(dir);
}

/** Ход по плану: печать (`dry`) или исполнение — два режима. */
interface Mode {
  step(step: Step, tally: Tally): Promise<void>;
  ignore(names: readonly string[]): void;
  markRoot(): void;
  say(line: string): void;
  close(): void;
}

/** Пройти шаги, `.gitignore`, сентинел и личность git; итог — строкой. */
async function walk(
  context: StepContext,
  mode: Mode,
  steps: readonly Step[],
): Promise<string> {
  const tally = new Tally();
  for (const step of steps) await mode.step(step, tally);
  const unignored = context.workspace.unignored(tally.repos());
  if (unignored.length > 0) {
    mode.ignore(unignored);
    mode.say("в mp не закоммичено: .gitignore");
  }
  mode.markRoot();
  await warnIdentity(context);
  mode.say(tally.summary());
  mode.close();
  return tally.summary();
}

/** `dry`: строки плана с префиксом, ни одной записи. */
class Printing implements Mode {
  constructor(private readonly context: StepContext) {}

  step(step: Step, tally: Tally): Promise<void> {
    this.say(step.planned());
    step.plan(tally);
    return Promise.resolve();
  }

  ignore(): void {}

  markRoot(): void {}

  say(line: string): void {
    this.context.say(`план: ${line}`);
  }

  close(): void {
    this.context.say("dry-run: ничего не выполнено");
  }
}

/** Исполнение: клоны, запись `.gitignore` и сентинела. */
class Applying implements Mode {
  constructor(private readonly context: StepContext) {}

  step(step: Step, tally: Tally): Promise<void> {
    return step.apply(this.context, tally);
  }

  ignore(names: readonly string[]): void {
    this.context.workspace.ignore(names);
  }

  markRoot(): void {
    this.context.workspace.markRoot();
  }

  say(line: string): void {
    this.context.say(line);
  }

  close(): void {}
}

/** Нет личности git глобально — подсказка; сама команда её не задаёт. */
async function warnIdentity(context: StepContext): Promise<void> {
  for (const key of ["user.name", "user.email"]) {
    const probe = await context.shell.run([
      "git",
      "config",
      "--global",
      "--get",
      key,
    ]);
    if (probe.code === 0 && probe.stdout.trim() !== "") continue;
    context.say(
      "warning: нет личности git — git config --global user.name … && " +
        "git config --global user.email …",
    );
    return;
  }
}

/** stdout пуст: весь вывод — служебные строки в stderr. */
export function renderMpClone(): string {
  return "";
}

export const mpCloneCommand = defineCommand({
  path: ["mp-clone"],
  keys: {},
  errorName: "mp-clone",
  summary: "Развернуть рабочую область mp из GitLab: недостающие субрепо.",
  usage: "mpu mp-clone [dry]",
  help: `Звать на чистой машине или когда в ~/mr/mp не хватает субрепо —
до mp-init. В отличие от git clone руками, не трогает склонированное,
клонирует поверх каталогов-пустышек с сохранением локальных файлов и
повторным вызовом ничего не меняет.

Субрепо — folders[].path из ~/mr/mp/mp.code-workspace (кроме «.») и
служебные ${SERVICE_REPOS.join(", ")}. Адрес —
${urlOf("<имя>")}, ветка — дефолтная на сервере.

По каталогу: нет — git clone; свой .git — «уже есть», не трогается
никак; без своего .git (пустышка) — копия в
~/tmp/mp-clone-backup/<ГГГГММДД-ччммсс>/<имя>, клон поверх, правленые
отслеживаемые файлы возвращаются из копии («восстановлен локальный»);
репозитория нет на сервере — предупреждение, код не меняется.

Ключ хоста GitLab команда не принимает сама: нет его в known_hosts —
отказ с отпечатком и готовой строкой ssh-keyscan. Недостающие строки
/<имя>/ дописывает в .gitignore корня (не коммитит), создаёт
~/mr/mp/.mp-workspace-root. Нет личности git — предупреждение.

dry печатает план с префиксом «план:»; git ls-remote при этом
выполняется, клонов и записей нет.

Весь вывод идёт в stderr, stdout пуст.

Exit: 0 — область готова, в том числе без субрепо, которых нет на
сервере; 2 — нет ~/mr/mp/mp.code-workspace; 1 — упал git (ls-remote
ошибкой сети или ключа, clone); 3 — ключа GitLab нет в known_hosts.`,
  examples: ["mpu ask mp-clone dry", "mpu ask mp-clone"],
  policy: "rw",
  argsSchema,
  forms: { "dry-run": { short: "n" } },
  resultSchema,
  run: (args: MpCloneArgs, io: MpCloneIo) => runMpClone(args, io),
  render: () => renderMpClone(),
  textExitCode: (result: MpCloneResult) => result.exitCode,
});
