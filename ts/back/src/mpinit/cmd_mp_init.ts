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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { checkAnswers, Health } from "./answers.ts";
import { reportContainers } from "./containers.ts";
import {
  type Clock,
  type Docker,
  type ProcessOutcome,
  systemClock,
  systemDocker,
} from "./docker.ts";
import {
  CORE_IMAGES,
  missingImages,
  type StandDirs,
  type StandImage,
  WEB_IMAGE,
} from "./images.ts";
import type { MigrationsContext } from "./migrations.ts";
import { composeServicesOf, servicesOf, strangersOf } from "./overrides.ts";
import { NoOzon, Ozon, type OzonStand } from "./ozon.ts";
import { fillRates, type RatesContext } from "./rates.ts";
import {
  type CoreStack,
  coreStacks,
  NETWORK,
  type PlanFacts,
  type Step,
  stepLine,
  SUBNET,
  VOLUME,
} from "./plan.ts";
import {
  type Admission,
  CONFLICTING,
  depsTagOf,
  LocalStack,
  nexusAccessOf,
  NO_WEB,
  refused,
  type StandFiles,
  textOr,
  type WebContext,
  webPages,
} from "./web.ts";

const argsSchema = z.object({
  "dry-run": z
    .boolean()
    .default(false)
    .describe("напечатать команды, не выполняя мутаций"),
});

const resultSchema = z.object({
  steps: z.array(z.string()).describe("выполненные (или напечатанные) шаги"),
  web: z.boolean().describe("поднимался ли web-стек"),
  dryRun: z.boolean(),
  exitCode: z
    .number()
    .int()
    .describe("код выхода: 0 либо rc упавшего docker-вызова, 1:1"),
});

type MpInitArgs = z.infer<typeof argsSchema>;
type MpInitResult = z.infer<typeof resultSchema>;

/** Срез порта: окружение (каталог стенда) и печать служебных строк. */
export type MpInitIo = Pick<CommandIo, "env" | "progress">;

/** Подстановки для тестов: живого docker, часов и стенда у них нет. */
export interface MpInitOptions extends Partial<StandFiles> {
  readonly docker?: Docker;
  readonly clock?: Clock;
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
  // Хвостовой `/` снимается: путь сравнивается с меткой compose
  // `working_dir` побайтно (`/a/b/` в ней не найдётся) и режется до
  // родителя, где `/a/b/` дал бы соседа самому себе.
  if (override !== undefined && override !== "") {
    return override.replace(/(.)\/+$/, "$1");
  }
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
  return `${rootDirOf(configDir)}/local-stack`;
}

/** Корень `mp` — родитель mp-config-local: контекст сборки образов. */
function rootDirOf(configDir: string): string {
  return configDir.slice(0, configDir.lastIndexOf("/"));
}

/** Существует ли путь; ошибка доступа равнозначна отсутствию. */
function existsOnDisk(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Имена в каталоге диска. */
function namesIn(dir: string): readonly string[] {
  return readdirSync(dir);
}

/** Всё, что нужно шагам прогона, — одно на вызов. */
interface Run {
  readonly io: MpInitIo;
  readonly docker: Docker;
  readonly files: StandFiles;
  readonly dryRun: boolean;
  readonly configDir: string;
  /** Напечатанные (в `dry`) или выполненные шаги — поле результата. */
  readonly done: string[];
}

/** Где стенд: каталог mp-config-local и соседний local-stack. */
interface StandPlace extends StandDirs {
  readonly localStackPath: string;
  /** `undefined` — каталога нет, web пропускается. */
  readonly localStackDir: string | undefined;
}

/** Найти каталоги стенда; нет mp-config-local — ошибка ввода (exit 2). */
function placeOf(io: MpInitIo, exists: (path: string) => boolean): StandPlace {
  const configDir = configDirOf(io);
  if (!exists(configDir)) {
    throw new UsageError(`каталог mp-config-local не найден: ${configDir}`, {
      hint: "задай MPU_MP_CONFIG_LOCAL=<путь>",
    });
  }
  const localStackPath = localStackDirOf(configDir);
  return {
    configDir,
    rootDir: rootDirOf(configDir),
    localStackPath,
    localStackDir: exists(localStackPath) ? localStackPath : undefined,
  };
}

/** Ход вызова: probe'ы, образы, core, сводка, web. */
export async function runMpInit(
  args: MpInitArgs,
  io: MpInitIo,
  options: MpInitOptions = {},
): Promise<MpInitResult> {
  const exists = options.exists ?? existsOnDisk;
  const place = placeOf(io, exists);
  const run: Run = {
    io,
    docker: options.docker ?? systemDocker,
    files: {
      readText: options.readText ?? ((path) => readFileSync(path, "utf8")),
      readBytes:
        options.readBytes ?? ((path) => new Uint8Array(readFileSync(path))),
      listDir: options.listDir ?? namesIn,
    },
    dryRun: args["dry-run"],
    configDir: place.configDir,
    done: [],
  };
  const up = await upStand(run, place, exists, options.clock ?? systemClock);
  // `web: false` при отказе — не «каталог есть», а «поднимался ли он»:
  // до web дело не дошло, и обещать обратное схема не должна.
  if (up.code !== 0) {
    return {
      steps: run.done,
      web: false,
      dryRun: run.dryRun,
      exitCode: up.code,
    };
  }
  const web = up.services.length > 0;
  const ozon = ozonStandOf(place, exists, run.files);
  const code = await ozon.up({ ...webContext(run), dryRun: run.dryRun });
  if (code !== 0) {
    return { steps: run.done, web, dryRun: run.dryRun, exitCode: code };
  }
  // Проверка ответом — после всех шагов и до итоговой строки: та
  // закрывает прогон. В `dry` отвечать некому — стенд не поднимался.
  if (!run.dryRun) {
    await checkAnswers(webContext(run), [
      ...webPages(up.services),
      new Health(),
      ...ozon.addresses,
    ]);
  }
  io.progress(finalLine(up.services, run.dryRun));
  return { steps: run.done, web, dryRun: run.dryRun, exitCode: 0 };
}

/**
 * Стенд ozon (шаг 6): его compose — в local-stack, поэтому без
 * local-stack его нет, как и без чекаута `ozon`.
 */
function ozonStandOf(
  place: StandPlace,
  exists: (path: string) => boolean,
  files: StandFiles,
): OzonStand {
  if (place.localStackDir === undefined) {
    return new NoOzon(
      `стенд ozon: каталога ${place.localStackPath} нет — пропуск`,
    );
  }
  const checkout = `${place.rootDir}/ozon`;
  if (!exists(checkout)) {
    return new NoOzon(`стенд ozon: чекаута ${checkout} нет — пропуск`);
  }
  return new Ozon(
    place.localStackDir,
    textOr(files, `${checkout}/pnpm-lock.yaml`),
    exists(`${checkout}/node_modules`),
  );
}

/** Шаги 1–5 по порядку: отказ — его код, иначе поднятые услуги web. */
async function upStand(
  run: Run,
  place: StandPlace,
  exists: (path: string) => boolean,
  clock: Clock,
): Promise<Admission> {
  const prepared = await prepare(run);
  if (prepared !== 0) return refused(prepared);
  const built = await buildImages(run, place, imagesOf(place));
  if (built !== 0) return refused(built);
  const facts: PlanFacts = {
    configDir: place.configDir,
    localStackDir: place.localStackDir,
    exists,
  };
  const context: MigrationsContext = {
    docker: run.docker,
    clock,
    progress: run.io.progress,
    cwd: place.configDir,
  };
  const core = await upCore(run, coreStacks(facts), context);
  if (core !== 0) return refused(core);
  if (place.localStackDir === undefined) {
    run.io.progress(
      `каталог local-stack не найден: ${place.localStackPath}; ` +
        "web-стек пропущен",
    );
    return NO_WEB;
  }
  const stack = new LocalStack(place.localStackDir, place.rootDir, run.files);
  return await upWeb(run, stack);
}

/** Образы стенда: web-образ нужен, только когда есть local-stack. */
function imagesOf(place: StandPlace): readonly StandImage[] {
  if (place.localStackDir === undefined) return CORE_IMAGES;
  return [...CORE_IMAGES, WEB_IMAGE];
}

/**
 * Недостающие образы собираются (шаг 3): строка `собираю`, затем сам
 * шаг — в `dry` только печать. Падение сборки — её rc наружу.
 */
async function buildImages(
  run: Run,
  dirs: StandDirs,
  images: readonly StandImage[],
): Promise<number> {
  for (const image of await missingImages(run.docker, run.configDir, images)) {
    run.io.progress(`собираю ${image.tag}`);
    const code = await execute(run, image.buildStep(dirs));
    if (code === 0) continue;
    run.io.progress(`mpu mp-init: сборка ${image.tag} упала (rc=${code})`);
    return code;
  }
  return 0;
}

/**
 * Core-стеки по порядку, затем — вне `dry`, где контейнеров ещё нет, —
 * сводка контейнеров, и курсы валют: их проба идёт и в `dry`.
 * Возвращает код отказа либо 0.
 */
async function upCore(
  run: Run,
  stacks: readonly CoreStack[],
  context: MigrationsContext,
): Promise<number> {
  for (const stack of stacks) {
    const code = await upStack(run, stack, context);
    if (code !== 0) return code;
  }
  if (!run.dryRun) {
    await reportContainers(run.docker, run.io.progress, run.configDir);
  }
  return await fillRates(
    stacks.map((stack) => stack.rates),
    ratesContext(run),
  );
}

/** Итог невыполненного в `dry` шага. */
const IDLE: ProcessOutcome = { code: 0, stdout: "", stderr: "" };

/** Исполнение шагов курсов: печать, как у всех, и вывод — значением. */
function ratesContext(run: Run): RatesContext {
  return {
    docker: run.docker,
    progress: run.io.progress,
    cwd: run.configDir,
    dryRun: run.dryRun,
    perform: async (argv) => {
      const step: Step = { name: "rates", argv, cwd: run.configDir };
      announce(run, step);
      if (run.dryRun) return IDLE;
      return await run.docker.watch(step.argv, step.cwd);
    },
  };
}

/**
 * Один core-стек: сверка overrides, `up`, проверка миграций (вне `dry`).
 * Fail-fast: следующие стеки не поднимаются, а код упавшего docker'а
 * идёт наружу как есть (`mp-init.md`).
 */
async function upStack(
  run: Run,
  stack: CoreStack,
  context: MigrationsContext,
): Promise<number> {
  const verified = await verifyOverrides(run, stack);
  if (verified !== 0) return verified;
  const failed = await execute(run, stack.step);
  if (failed !== 0) return stackFailed(run, stack.step, failed);
  if (run.dryRun) return 0;
  return await stack.migrations.verify(context);
}

/**
 * Каждый сервис override-файла обязан быть в compose стека: иначе `up`
 * падает целиком. Сверка — проба, выполняется и в `dry`.
 */
async function verifyOverrides(run: Run, stack: CoreStack): Promise<number> {
  if (stack.overrides.length === 0) return 0;
  const probe = await run.docker.probe(stack.servicesArgv, run.configDir);
  if (probe.code !== 0) {
    // Не снятый список — не повод пропустить сверку молча.
    run.io.progress(
      `mpu mp-init: compose config стека '${stack.step.name}' упал ` +
        `(rc=${probe.code})`,
    );
    return probe.code;
  }
  const known = composeServicesOf(probe.stdout);
  for (const path of stack.overrides) {
    const strangers = strangersOf(servicesOf(run.files.readText(path)), known);
    if (strangers.length === 0) continue;
    run.io.progress(
      `mpu mp-init: override ${path}: нет в compose: ${strangers.join(", ")}`,
    );
    return 1;
  }
  return 0;
}

/**
 * Web поверх core (M3): стоп конфликтующих → инфра SW → вход в Nexus →
 * тег зависимостей sw-back → web. Отказ — его код; иначе поднятые
 * услуги: без входа или образа зависимостей — без sw-back.
 */
async function upWeb(run: Run, stack: LocalStack): Promise<Admission> {
  await stopConflicting(run);
  const context = webContext(run);
  for (const step of await stack.infraSteps(context)) {
    const failed = await execute(run, step);
    if (failed !== 0) return refused(stackFailed(run, step, failed));
  }
  const tag = await depsTagOf(run.files, `${stack.rootDir}/sw-back`);
  const access = nexusAccessOf(
    textOr(run.files, dockerConfigOf(run.io)),
    stack,
  );
  const admission = await access.enter(context, () => tag.admit(context));
  if (admission.code !== 0) return admission;
  const code = await execute(run, stack.webStep(admission.services, tag));
  if (code === 0) return admission;
  run.io.progress(`mpu mp-init: web упал (rc=${code})`);
  return refused(code);
}

/**
 * Гашение конфликтующих: в dry-run печатается весь список с пометкой,
 * в реальном прогоне — только запущенные; никого — шага нет (спека).
 */
async function stopConflicting(run: Run): Promise<void> {
  const names = run.dryRun ? CONFLICTING : await runningOf(run, CONFLICTING);
  if (names.length === 0) return;
  await execute(run, {
    name: "stop-conflicting",
    argv: ["docker", "stop", ...names],
    cwd: run.configDir,
    comment: "# только запущенные",
  });
}

/** `config.json` docker'а; без HOME — пусто: входа не видно. */
function dockerConfigOf(io: MpInitIo): string {
  const home = io.env("HOME");
  if (home === undefined || home === "") return "";
  return `${home}/.docker/config.json`;
}

/** Контекст шагов web: печать и исполнение — как у всех шагов. */
function webContext(run: Run): WebContext {
  return {
    docker: run.docker,
    cwd: run.configDir,
    progress: run.io.progress,
    perform: (step) => execute(run, step),
  };
}

/** Отказ стека: строка оператору, код упавшего docker'а — наружу. */
function stackFailed(run: Run, step: Step, code: number): number {
  run.io.progress(
    `mpu mp-init: стек '${step.name}' упал (rc=${code}); ` +
      "остальные не поднимаю",
  );
  return code;
}

/** Порядок услуг web в финальной строке. */
const FINAL_ORDER = ["sw-front", "sw-back", "sl-front"];

/**
 * Финальная строка прогона; печатается в stderr, как и всё прочее.
 * Web назван перечнем поднятого — без sw-back его в строке нет.
 */
export function finalLine(
  services: readonly string[],
  dryRun: boolean,
): string {
  if (dryRun) return "dry-run: ничего не выполнено";
  if (services.length === 0) {
    return "mp-init: core поднят — nats, sl-0, sl-1, nginx, dt-host";
  }
  const web = FINAL_ORDER.filter((name) => services.includes(name));
  return (
    "mp-init: поднят core (nats/sl-0/sl-1/nginx/dt-host) + " +
    `web (${web.join("/")})`
  );
}

/**
 * Печать шага и его исполнение; в dry-run — только печать. Возвращает
 * код упавшего вызова либо 0.
 */
async function execute(run: Run, step: Step): Promise<number> {
  announce(run, step);
  if (run.dryRun) return 0;
  const code = await run.docker.run(step.argv, step.cwd, step);
  // Гашение конфликтующих контейнеров кода не проверяет: контейнер мог
  // остановиться сам между probe'ом и вызовом, и это не отказ.
  if (step.name === "stop-conflicting") return 0;
  return code;
}

/** Строка шага — оператору и в поле результата. */
function announce(run: Run, step: Step): void {
  const line = stepLine(step);
  run.io.progress(line);
  run.done.push(line);
}

/** Сеть создаётся только при отсутствии: вызов идемпотентен. */
async function ensureNetwork(run: Run): Promise<number> {
  const probe = await run.docker.probe(
    ["docker", "network", "inspect", NETWORK],
    run.configDir,
  );
  if (probe.code === 0) return 0;
  // `--subnet=…` одним токеном: форма строки — часть контракта
  // вывода (`mp-init.md`, шаг 1), а не вкус docker'а.
  return await mutate(run, [
    "docker",
    "network",
    "create",
    "--driver=bridge",
    NETWORK,
    `--subnet=${SUBNET}`,
  ]);
}

/** Том создаётся только при отсутствии; он external у compose'а. */
async function ensureVolume(run: Run): Promise<number> {
  const probe = await run.docker.probe(
    ["docker", "volume", "inspect", VOLUME],
    run.configDir,
  );
  if (probe.code === 0) return 0;
  return await mutate(run, ["docker", "volume", "create", VOLUME]);
}

/** Сеть и том: оба создаются только при отсутствии. */
async function prepare(run: Run): Promise<number> {
  const network = await ensureNetwork(run);
  if (network !== 0) return network;
  return await ensureVolume(run);
}

/**
 * Мутирующий вспомогательный вызов: печать, затем запуск. Возвращает
 * rc упавшего вызова либо 0 — код выхода команды равен ему как есть
 * (спека), а исключением произвольный код наружу не вынести: точка
 * входа отвечает на доменную ошибку единицей.
 */
async function mutate(
  run: Run,
  argv: readonly [string, ...string[]],
): Promise<number> {
  const code = await execute(run, {
    name: "prepare",
    argv,
    cwd: run.configDir,
  });
  if (code !== 0) {
    run.io.progress(
      `mpu mp-init: ${argv.slice(0, 3).join(" ")} упал (rc=${code})`,
    );
  }
  return code;
}

/** Какие из конфликтующих контейнеров сейчас запущены. */
async function runningOf(
  run: Run,
  names: readonly string[],
): Promise<readonly string[]> {
  const running: string[] = [];
  for (const name of names) {
    const probe = await run.docker.probe(
      ["docker", "inspect", "-f", "{{.State.Running}}", name],
      run.configDir,
    );
    if (probe.code === 0 && probe.stdout.trim() === "true") running.push(name);
  }
  return running;
}

/**
 * stdout команды пуст: весь её вывод — служебные строки в stderr
 * (`mp-init.md`, «Ввод/вывод»), а они уходят портом `progress`.
 */
export function renderMpInit(): string {
  return "";
}

export const mpInitCommand = defineCommand({
  path: ["mp-init"],
  keys: {},
  errorName: "mp-init",
  summary: "Поднять локальный стенд целиком: core-стеки и web поверх.",
  usage: "mpu mp-init [dry]",
  help: `Звать, когда локальный стенд надо поднять с нуля или после остановки.

Поднимает локальный стенд: docker-сеть и общий том, недостающие
core-образы, затем core-стеки в фиксированном порядке (nats, sl-0, sl-1,
nginx, dt-host), затем web поверх них. Порядок — часть контракта:
compose-зависимостей между стеками нет, и стенд собирается правильно
только так.

Нет образа (mp-back:local, mp-pg:local, mp-dt:local, при local-stack —
sl-front-dev:local) — собирается командой build-алиаса (строка «собираю
<образ>»); есть тег — сборки нет.

До up стека его override-файлы сверяются с compose: сервис override без
пары в compose — отказ с именем файла. После up sl-0 и sl-1 команда
ждёт контейнер миграций (до 10 мин) и отказывает, если он вышел не с 0;
после core — предупреждения о контейнерах в петле или вышедших с ошибкой.

dry печатает команды, не выполняя ни одной мутации; inspect, сверка
overrides и проба курсов при этом выполняются, миграции и сводка — нет.

После core — курсы валют: shared.currency_rates на sl-0 пуста — backfill в
sl-0-cli (~10 мин), затем syncFullHistory в cli каждого инстанса; не
пуста — пропуск. Пропущенные backfill'ом дни — одной строкой warning с
командой догона.

Web: инфра SW (mp-sw-pg, redis-dev) из local-stack, если она не в сети
local-stack-sw-db-net; вход в nexus.btlz-api.ru по NPM_AUTH из
local-stack/.env (пароль — только stdin); web — compose local-stack с
--no-deps. Нет входа или образа зависимостей sw-back под тег lock —
предупреждение, web без sw-back.

Есть чекаут ozon — стенд вертикали из local-stack/ozon: пакет
@sw-back/workspace-access версии pnpm-lock публикуется в Verdaccio, если
его там нет; без node_modules — установка и сборка. Затем проверка
ответом по адресам (curl -L): не 200 — warning, код не меняется; в dry
проверки нет.

Каталог mp-config-local берётся из переменной окружения
MPU_MP_CONFIG_LOCAL, иначе ~/mr/mp/mp-config-local. Каталог web-стека —
соседний local-stack; нет его — web пропускается, и это не ошибка.

Сеть и том создаются только при отсутствии; стеки пересоздаются всегда.
Упавший шаг останавливает всё: следующие не выполняются.

Весь вывод идёт в stderr, stdout пуст.

Exit: 0 — успех, в том числе без web-стека; 2 — каталог mp-config-local
не найден; 1 — override расходится с compose, миграции упали или не
завершились, dist пакета ozon пуст или нет коммита с его версией; иначе
код упавшего docker (курсы, вход в Nexus, web, стенд ozon).`,
  examples: ["mpu mp-init dry", "mpu mp-init"],
  policy: "rw",
  argsSchema,
  forms: { "dry-run": { short: "n" } },
  resultSchema,
  run: (args: MpInitArgs, io: MpInitIo) => runMpInit(args, io),
  render: () => renderMpInit(),
  textExitCode: (result: MpInitResult) => result.exitCode,
});
