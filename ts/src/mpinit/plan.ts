/**
 * Последовательность шагов `mpu mp-init` (`docs/specs/mp-init.md`).
 *
 * Модуль чистый: на вход — каталоги и факты о диске (какие файлы есть),
 * на выход — список шагов по порядку. Порядок здесь и есть контракт, а
 * не деталь исполнения: compose-зависимостей между стеками нет, и
 * корректность стенда держится ровно на том, что web поднимается после
 * core, а конфликтующие контейнеры гасятся до web. Сделав порядок
 * данными, мы получили возможность проверить его тестом, не запуская
 * docker.
 */

import { shellCommand } from "../exec/mod.ts";

/** Шаг плана: что запустить и в каком каталоге. */
export interface Step {
  /** Имя шага для сообщений об отказе (`стек '<name>' упал`). */
  readonly name: string;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  /** Хвост печатаемой строки; у stop-шага — `# только запущенные`. */
  readonly comment?: string;
}

/** Что известно о диске и стенде на момент построения плана. */
export interface PlanFacts {
  /** Каталог mp-config-local; все пути шагов — от него. */
  readonly configDir: string;
  /** Каталог web-стека; `undefined` — web пропускается целиком. */
  readonly localStackDir: string | undefined;
  /** Существует ли файл по абсолютному пути. */
  readonly exists: (path: string) => boolean;
  /**
   * Контейнеры, которые надо погасить перед web. В dry-run сюда идёт
   * весь список конфликтующих, в реальном прогоне — только реально
   * запущенные (`mp-init.md`, «Граничные случаи»).
   */
  readonly conflicting: readonly string[];
}

/** Конфликтующие с web-стеком контейнеры; порядок — из спеки. */
export const CONFLICTING = ["mp-sw-api", "nextjs-dev", "mp-sl-front-dev"];

/** Обязательные образы core: пара «образ → build-алиас». */
export const CORE_IMAGES: readonly (readonly [string, string])[] = [
  ["mp-back:local", "sl-build-image"],
  ["mp-pg:local", "mp-pg-build-image"],
  ["mp-dt:local", "mp-dt-build-image"],
];

/** Образ web-стека: его отсутствие — предупреждение, а не отказ. */
export const WEB_IMAGE: readonly [string, string] = [
  "sl-front-dev:local",
  "sl-front-build-dev-image",
];

/** Имя docker-сети и её подсеть. */
export const NETWORK = "mp-shared-net";
export const SUBNET = "178.20.0.0/16";
/** External-том compose'а: без него стеки не поднимутся. */
export const VOLUME = "mp-back-node-modules";

/** Env-файл стека: имя и признак необязательности. */
interface EnvFileRef {
  readonly name: string;
  readonly optional?: true;
}

/** Объявление одного core-стека: имя, env-файлы, compose-файлы. */
interface StackSpec {
  readonly name: string;
  /**
   * Env-файлы в порядке передачи compose'у. Порядок — контракт: у
   * compose позже заданный ключ побеждает.
   *
   * Опциональность отмечена у каждого файла, а не вынесена во второй
   * список: иначе обязательные и необязательные пришлось бы склеивать
   * в argv, и порядок из спеки (`.env` между базовыми) не выразить.
   * Опциональны только `.env` и `.sl-*.env`; базовые `.sl-*.base.env`
   * обязательны — без них стек поднялся бы на неполном наборе
   * переменных и молча встал бы «не тем».
   */
  readonly env: readonly EnvFileRef[];
  readonly files: readonly string[];
  /** Overrides из каталога local-stack; включаются при наличии. */
  readonly overrides: readonly string[];
}

/**
 * Core-стеки строго в порядке запуска: nats → sl-0 → sl-1 → nginx →
 * dt-host. Порядок кортежа и есть порядок шагов.
 */
const STACKS: readonly StackSpec[] = [
  {
    name: "mp-nats",
    env: [{ name: ".sl-base.env" }, { name: ".env", optional: true }],
    files: ["compose.mp-nats.yaml"],
    overrides: [],
  },
  {
    name: "sl-0",
    env: [
      { name: ".sl-base.env" },
      { name: ".env", optional: true },
      { name: ".sl-0.base.env" },
      { name: ".sl-0.env", optional: true },
    ],
    files: [
      "compose.sl-base.yaml",
      "compose.sl-pg.yaml",
      "compose.sl-main.yaml",
    ],
    overrides: [
      "sl-base.observability-off.yaml",
      "sl-main.observability-off.yaml",
    ],
  },
  {
    name: "sl-1",
    env: [
      { name: ".sl-base.env" },
      { name: ".env", optional: true },
      { name: ".sl-1.base.env" },
      { name: ".sl-1.env", optional: true },
    ],
    files: [
      "compose.sl-base.yaml",
      "compose.sl-pg.yaml",
      "compose.pgbouncer.yaml",
      "compose.sl-instance.yaml",
    ],
    overrides: [
      "sl-base.observability-off.yaml",
      "sl-instance.observability-off.yaml",
    ],
  },
  {
    name: "mp-nginx",
    env: [{ name: ".shared.env" }, { name: ".env", optional: true }],
    files: ["compose.mp-nginx.yaml"],
    overrides: [],
  },
  {
    name: "dt-host",
    env: [
      { name: ".sl-base.env" },
      { name: ".env", optional: true },
      { name: ".sl-dt.base.env" },
      { name: ".sl-dt.env", optional: true },
    ],
    files: ["compose.sl-dt-host.yaml"],
    overrides: [],
  },
];

/** Аргументы одного `docker compose … up -d --force-recreate`. */
function composeUp(
  facts: PlanFacts,
  stack: StackSpec,
): readonly [string, ...string[]] {
  const argv: string[] = ["docker", "compose"];
  for (const file of stack.env) {
    const path = `${facts.configDir}/${file.name}`;
    // Несуществующий env-файл в argv — отказ compose'а целиком,
    // поэтому необязательные включаются только по факту наличия, а
    // обязательные передаются всегда: их отсутствие обязано быть
    // громким отказом compose'а, а не тихой недостачей переменных.
    if (file.optional === true && !facts.exists(path)) continue;
    argv.push("--env-file", path);
  }
  for (const file of stack.files) argv.push("-f", `${facts.configDir}/${file}`);
  for (const override of stack.overrides) {
    if (facts.localStackDir === undefined) continue;
    const path = `${facts.localStackDir}/overrides/${override}`;
    if (facts.exists(path)) argv.push("-f", path);
  }
  // `--remove-orphans` не передаётся никогда: он снёс бы контейнеры
  // соседних стеков того же compose-проекта (спека).
  argv.push("up", "-d", "--force-recreate");
  return argv as [string, ...string[]];
}

/** План core-части: пять стеков по порядку. */
function corePlan(facts: PlanFacts): readonly Step[] {
  return STACKS.map((stack) => ({
    name: stack.name,
    argv: composeUp(facts, stack),
    cwd: facts.configDir,
  }));
}

/**
 * План web-части: БД-зависимости sw-back, гашение конфликтующих
 * контейнеров, затем сам web-стек. Пустой список, если каталога нет.
 */
function webPlan(facts: PlanFacts): readonly Step[] {
  if (facts.localStackDir === undefined) return [];
  const steps: Step[] = [{
    name: "sw-back-deps",
    argv: [
      "docker",
      "compose",
      "--env-file",
      `${facts.configDir}/.sw-back.base.env`,
      "-f",
      `${facts.configDir}/compose.sw-back.yaml`,
      "up",
      "-d",
      "--force-recreate",
      "pg",
      "redis",
    ],
    cwd: facts.configDir,
  }];
  if (facts.conflicting.length > 0) {
    steps.push({
      name: "stop-conflicting",
      argv: ["docker", "stop", ...facts.conflicting] as [string, ...string[]],
      cwd: facts.configDir,
      comment: "# только запущенные",
    });
  }
  steps.push({
    name: "web",
    argv: [
      "docker",
      "compose",
      "-f",
      `${facts.localStackDir}/docker-compose.yml`,
      "up",
      "-d",
      "--force-recreate",
    ],
    cwd: facts.localStackDir,
  });
  return steps;
}

/**
 * Весь план: core, затем web. Склейка отдельной функцией — чтобы
 * порядок двух частей был виден одной строкой и проверялся тестом.
 */
export function fullPlan(facts: PlanFacts): readonly Step[] {
  return [...corePlan(facts), ...webPlan(facts)];
}

/** Печатаемая строка шага: `$ <команда>` плюс комментарий, если есть. */
export function stepLine(step: Step): string {
  const command = `$ ${shellCommand(step.argv)}`;
  return step.comment === undefined ? command : `${command}  ${step.comment}`;
}
