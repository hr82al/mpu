/**
 * Команда `mpu mp-init` (`docs/specs/mp-init.md`): поднять локальный
 * стенд целиком.
 *
 * Команда ничего не решает — она печатает и выполняет фиксированную
 * последовательность (`plan.ts`). Здесь только то, чего в чистом плане
 * быть не может: probe'ы диска и docker'а, исполнение шагов и правило
 * «упал шаг — дальше не идём».
 *
 * Probe'ы (inspect сети, тома, образов, состояния контейнеров) читающие
 * и выполняются в обоих режимах: без них план построить нечем, а
 * состояния они не меняют. Мутации (`create`, `up`, `stop`) в dry-run
 * не выполняются ни одной.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import {
  CONFLICTING,
  CORE_IMAGES,
  fullPlan,
  NETWORK,
  type PlanFacts,
  type Step,
  stepLine,
  SUBNET,
  VOLUME,
  WEB_IMAGE,
} from "./plan.ts";

const argsSchema = z.object({
  "dry-run": z.boolean().default(false).describe(
    "напечатать команды, не выполняя мутаций",
  ),
});

const resultSchema = z.object({
  steps: z.array(z.string()).describe("выполненные (или напечатанные) шаги"),
  web: z.boolean().describe("поднимался ли web-стек"),
  dryRun: z.boolean(),
  exitCode: z.number().int().describe(
    "код выхода: 0 либо rc упавшего docker-вызова, 1:1",
  ),
});

type MpInitArgs = z.infer<typeof argsSchema>;
type MpInitResult = z.infer<typeof resultSchema>;

/** Срез порта: окружение (каталог стенда) и печать служебных строк. */
export type MpInitIo = Pick<CommandIo, "env" | "progress">;

/** Итог запуска процесса: код и собранный stdout. */
export interface ProcessOutcome {
  readonly code: number;
  readonly stdout: string;
}

/**
 * Запуск docker-процесса. Свой узкий порт, а не общий `RunProcess`:
 * здесь нужны и рабочий каталог (compose ищет относительные пути от
 * него), и stdout probe'ов, которого у общего порта нет.
 */
export type RunDocker = (
  argv: readonly string[],
  cwd: string,
) => Promise<ProcessOutcome>;

/** Подстановки для тестов: живого docker и стенда у них нет. */
export interface MpInitOptions {
  readonly runDocker?: RunDocker;
  readonly exists?: (path: string) => boolean;
}

/** Каталог стенда по умолчанию, относительно HOME. */
const DEFAULT_CONFIG_TAIL = "mr/mp/mp-config-local";

/**
 * Каталог mp-config-local: переменная окружения процесса, иначе путь
 * от HOME. Это единственное место семейства, где окружение остаётся
 * источником: оно указывает не предпочтение, а каталог чужого
 * репозитория (`mp-init.md`, «Конфигурация»).
 */
export function configDirOf(io: MpInitIo): string {
  const override = io.env("MPU_MP_CONFIG_LOCAL");
  if (override !== undefined && override !== "") return override;
  const home = io.env("HOME");
  if (home === undefined || home === "") {
    throw new UsageError("каталог mp-config-local не найден: HOME не задан", {
      hint: "задай MPU_MP_CONFIG_LOCAL=<путь>",
    });
  }
  return `${home}/${DEFAULT_CONFIG_TAIL}`;
}

/** Каталог web-стека — сосед mp-config-local. */
export function localStackDirOf(configDir: string): string {
  // Хвостовой `/` снимается: `MPU_MP_CONFIG_LOCAL=/a/b/` иначе дал бы
  // соседа самому себе (`/a/b/local-stack` вместо `/a/local-stack`).
  const trimmed = configDir.replace(/\/+$/, "");
  return `${trimmed.slice(0, trimmed.lastIndexOf("/"))}/local-stack`;
}

/** Существует ли путь; ошибка доступа равнозначна отсутствию. */
function existsOnDisk(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Ход вызова: probe'ы, план, исполнение по порядку. */
export async function runMpInit(
  args: MpInitArgs,
  io: MpInitIo,
  options: MpInitOptions = {},
): Promise<MpInitResult> {
  const dryRun = args["dry-run"];
  const run = options.runDocker ?? spawnDocker;
  const exists = options.exists ?? existsOnDisk;
  const configDir = configDirOf(io);
  if (!exists(configDir)) {
    throw new UsageError(`каталог mp-config-local не найден: ${configDir}`, {
      hint: "задай MPU_MP_CONFIG_LOCAL=<путь>",
    });
  }
  const localStackPath = localStackDirOf(configDir);
  const localStackDir = exists(localStackPath) ? localStackPath : undefined;

  const done: string[] = [];
  const prepared = await prepare(io, run, configDir, dryRun, done);
  if (prepared !== 0) {
    return { steps: done, web: false, dryRun, exitCode: prepared };
  }
  await checkImages(io, run, configDir, dryRun, localStackDir !== undefined);

  const facts: PlanFacts = {
    configDir,
    localStackDir,
    exists,
    // В dry-run печатается весь список конфликтующих с пометкой; в
    // реальном прогоне гасятся только запущенные (спека).
    conflicting: dryRun
      ? CONFLICTING
      : await runningOf(run, configDir, CONFLICTING),
  };
  const steps = fullPlan(facts);
  for (const step of steps) {
    // Строка о пропуске web печатается на своём месте — после core, а
    // не в начале: она про шаг 5, и оператор читает вывод сверху вниз.
    if (step.name === "sw-back-deps" && localStackDir === undefined) break;
    done.push(stepLine(step));
    const failed = await execute(io, run, step, dryRun);
    if (failed !== 0) {
      // Fail-fast: следующие стеки не поднимаются, а код упавшего
      // docker'а идёт наружу как есть (`mp-init.md`).
      io.progress(
        `mpu mp-init: стек '${step.name}' упал (rc=${failed}); ` +
          "остальные не поднимаю",
      );
      // `web: false` — не «каталог есть», а «поднимался ли он»: до
      // web дело не дошло, и обещать обратное схема не должна.
      return { steps: done, web: false, dryRun, exitCode: failed };
    }
  }
  if (localStackDir === undefined) {
    io.progress(
      `каталог local-stack не найден: ${localStackPath}; web-стек пропущен`,
    );
  }
  io.progress(finalLine(localStackDir !== undefined, dryRun));
  return {
    steps: done,
    web: localStackDir !== undefined,
    dryRun,
    exitCode: 0,
  };
}

/** Финальная строка прогона; печатается в stderr, как и всё прочее. */
export function finalLine(web: boolean, dryRun: boolean): string {
  if (dryRun) return "dry-run: ничего не выполнено";
  return web
    ? "mp-init: поднят core (nats/sl-0/sl-1/nginx/dt-host) + " +
      "web (sw-front/sw-back/sl-front)"
    : "mp-init: core поднят — nats, sl-0, sl-1, nginx, dt-host";
}

/**
 * Печать шага и его исполнение; в dry-run — только печать. Возвращает
 * код упавшего вызова либо 0.
 */
async function execute(
  io: MpInitIo,
  run: RunDocker,
  step: Step,
  dryRun: boolean,
): Promise<number> {
  io.progress(stepLine(step));
  if (dryRun) return 0;
  const outcome = await run(step.argv, step.cwd);
  // Гашение конфликтующих контейнеров кода не проверяет: контейнер мог
  // остановиться сам между probe'ом и вызовом, и это не отказ.
  if (step.name === "stop-conflicting") return 0;
  return outcome.code;
}

/** Сеть создаётся только при отсутствии: вызов идемпотентен. */
async function ensureNetwork(
  io: MpInitIo,
  run: RunDocker,
  cwd: string,
  dryRun: boolean,
  done: string[],
): Promise<number> {
  const probe = await run(["docker", "network", "inspect", NETWORK], cwd);
  if (probe.code === 0) return 0;
  return await mutate(
    io,
    run,
    // `--subnet=…` одним токеном: форма строки — часть контракта
    // вывода (`mp-init.md`, шаг 1), а не вкус docker'а.
    [
      "docker",
      "network",
      "create",
      "--driver=bridge",
      NETWORK,
      `--subnet=${SUBNET}`,
    ],
    cwd,
    dryRun,
    done,
  );
}

/** Том создаётся только при отсутствии; он external у compose'а. */
async function ensureVolume(
  io: MpInitIo,
  run: RunDocker,
  cwd: string,
  dryRun: boolean,
  done: string[],
): Promise<number> {
  const probe = await run(["docker", "volume", "inspect", VOLUME], cwd);
  if (probe.code === 0) return 0;
  return await mutate(
    io,
    run,
    ["docker", "volume", "create", VOLUME],
    cwd,
    dryRun,
    done,
  );
}

/** Сеть и том: оба создаются только при отсутствии. */
async function prepare(
  io: MpInitIo,
  run: RunDocker,
  cwd: string,
  dryRun: boolean,
  done: string[],
): Promise<number> {
  const network = await ensureNetwork(io, run, cwd, dryRun, done);
  if (network !== 0) return network;
  return await ensureVolume(io, run, cwd, dryRun, done);
}

/**
 * Мутирующий вспомогательный вызов: печать, затем запуск. Возвращает
 * rc упавшего вызова либо 0 — код выхода команды равен ему как есть
 * (спека), а исключением произвольный код наружу не вынести: точка
 * входа отвечает на доменную ошибку единицей.
 */
async function mutate(
  io: MpInitIo,
  run: RunDocker,
  argv: readonly string[],
  cwd: string,
  dryRun: boolean,
  done: string[],
): Promise<number> {
  const line = stepLine({
    name: "prepare",
    argv: argv as [string, ...string[]],
    cwd,
  });
  io.progress(line);
  done.push(line);
  if (dryRun) return 0;
  const outcome = await run(argv, cwd);
  if (outcome.code !== 0) {
    io.progress(
      `mpu mp-init: ${argv.slice(0, 3).join(" ")} упал (rc=${outcome.code})`,
    );
  }
  return outcome.code;
}

/**
 * Проверка образов. Отсутствие core-образа — отказ (стенд без них не
 * поднимется), отсутствие web-образа — предупреждение: web
 * необязателен, и ронять из-за него core незачем. В dry-run отказа нет
 * вовсе: смысл сухого прогона — показать всю последовательность.
 */
async function checkImages(
  io: MpInitIo,
  run: RunDocker,
  cwd: string,
  dryRun: boolean,
  withWeb: boolean,
): Promise<void> {
  const missing: string[] = [];
  for (const [image, alias] of CORE_IMAGES) {
    const probe = await run(["docker", "image", "inspect", image], cwd);
    if (probe.code !== 0) missing.push(`${image} → ${alias}`);
  }
  if (missing.length > 0) {
    const text = `нет обязательных образов: ${missing.join(", ")}; ` +
      "собери их в mp-config-local";
    // Отказ обычной доменной ошибкой: её код выхода и так 1 (спека).
    if (!dryRun) throw new DomainError(text);
    io.progress(`warning: ${text}`);
  }
  if (!withWeb) return;
  const [image, alias] = WEB_IMAGE;
  const probe = await run(["docker", "image", "inspect", image], cwd);
  if (probe.code !== 0) {
    io.progress(`warning: нет web-образов: ${image} → ${alias}`);
  }
}

/** Какие из конфликтующих контейнеров сейчас запущены. */
async function runningOf(
  run: RunDocker,
  cwd: string,
  names: readonly string[],
): Promise<readonly string[]> {
  const running: string[] = [];
  for (const name of names) {
    const probe = await run(
      ["docker", "inspect", "-f", "{{.State.Running}}", name],
      cwd,
    );
    if (probe.code === 0 && probe.stdout.trim() === "true") running.push(name);
  }
  return running;
}

/** Настоящий запуск docker: вывод идёт в терминал как есть. */
const spawnDocker: RunDocker = async (argv, cwd) => {
  const [bin, ...rest] = argv;
  const probe = rest[0] === "inspect" || rest[1] === "inspect";
  const output = await new Deno.Command(bin, {
    args: rest,
    cwd,
    stdin: "null",
    // У probe'ов stdout нужен нам, у мутаций — оператору: docker пишет
    // ход дела сам, и перехватывать его незачем.
    stdout: probe ? "piped" : "inherit",
    stderr: probe ? "piped" : "inherit",
  }).output();
  return {
    code: output.code,
    stdout: probe ? new TextDecoder().decode(output.stdout) : "",
  };
};

/**
 * stdout команды пуст: весь её вывод — служебные строки в stderr
 * (`mp-init.md`, «Ввод/вывод»), а они уходят портом `progress`.
 */
export function renderMpInit(): string {
  return "";
}

export const mpInitCommand = defineCommand({
  path: ["mp-init"],
  errorName: "mp-init",
  summary: "Поднять локальный стенд целиком: core-стеки и web поверх.",
  usage: "mpu mp-init [--dry-run|-n]",
  help: `Поднимает локальный стенд: docker-сеть и общий том, затем
core-стеки в фиксированном порядке (nats, sl-0, sl-1, nginx, dt-host),
затем web поверх них. Порядок — часть контракта: compose-зависимостей
между стеками нет, и стенд собирается правильно только так.

Образы команда не собирает. Нет core-образа (mp-back:local, mp-pg:local,
mp-dt:local) — останов с подсказкой, каким build-алиасом его собрать;
нет web-образа — предупреждение, core поднимается.

-n/--dry-run печатает все команды, не выполняя ни одной мутации;
inspect-проверки при этом выполняются — без них план не построить.

Каталог mp-config-local берётся из переменной окружения
MPU_MP_CONFIG_LOCAL, иначе ~/mr/mp/mp-config-local. Каталог web-стека —
соседний local-stack; нет его — web пропускается, и это не ошибка.

Сеть и том создаются только при отсутствии; стеки пересоздаются всегда.
Упавший стек останавливает всё: следующие не поднимаются.

Весь вывод идёт в stderr, stdout пуст.

Exit: 0 — успех, в том числе без web-стека; 2 — каталог mp-config-local
не найден; 1 — нет обязательных образов; иначе код упавшего docker.

Примеры: mpu mp-init --dry-run; mpu mp-init`,
  policy: "rw",
  argsSchema,
  forms: { "dry-run": { short: "n" } },
  resultSchema,
  run: (args: MpInitArgs, io: MpInitIo) => runMpInit(args, io),
  render: () => renderMpInit(),
  textExitCode: (result: MpInitResult) => result.exitCode,
});
