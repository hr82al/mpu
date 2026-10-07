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

import { quoteArg, shellCommand } from "../exec/mod.ts";
import type { RunInput } from "./docker.ts";
import {
  type Migrations,
  NO_MIGRATIONS,
  ServerMigrations,
} from "./migrations.ts";
import {
  type CurrencyRates,
  InstanceRates,
  MainRates,
  NO_RATES,
} from "./rates.ts";

/**
 * Шаг плана: что запустить и в каком каталоге. `env` печатается
 * префиксом строки, `stdin` — никогда: это путь секрета.
 */
export interface Step extends RunInput {
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
}

/** Конфликтующие с web-стеком контейнеры; порядок — из спеки. */
export const CONFLICTING = ["mp-sw-api", "nextjs-dev", "mp-sl-front-dev"];

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
  /** Проверка миграций после `up`: у sl-N — контейнер миграций. */
  readonly migrations: Migrations;
  /** Роль в заполнении курсов валют: main, инстанс или никакой. */
  readonly rates: CurrencyRates;
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
    migrations: NO_MIGRATIONS,
    rates: NO_RATES,
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
    migrations: new ServerMigrations("sl-0"),
    rates: new MainRates(),
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
    migrations: new ServerMigrations("sl-1"),
    rates: new InstanceRates("sl-1"),
  },
  {
    name: "mp-nginx",
    env: [{ name: ".shared.env" }, { name: ".env", optional: true }],
    files: ["compose.mp-nginx.yaml"],
    overrides: [],
    migrations: NO_MIGRATIONS,
    rates: NO_RATES,
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
    migrations: NO_MIGRATIONS,
    rates: NO_RATES,
  },
];

/**
 * `docker compose` с env-файлами и основными `-f` стека — общая голова
 * `up` и `config --services`: сверка overrides смотрит на тот же
 * compose, что поднимается, только без самих overrides.
 */
function composeHead(facts: PlanFacts, stack: StackSpec): string[] {
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
  return argv;
}

/** Существующие override-файлы стека, по порядку. */
function overridesOf(facts: PlanFacts, stack: StackSpec): readonly string[] {
  if (facts.localStackDir === undefined) return [];
  const dir = facts.localStackDir;
  return stack.overrides
    .map((name) => `${dir}/overrides/${name}`)
    .filter(facts.exists);
}

/** Core-стек, готовый к подъёму: шаг `up` и всё, что проверяется вокруг. */
export interface CoreStack {
  readonly step: Step;
  /** `docker compose … config --services` без overrides. */
  readonly servicesArgv: readonly string[];
  /** Существующие override-файлы — абсолютные пути. */
  readonly overrides: readonly string[];
  readonly migrations: Migrations;
  readonly rates: CurrencyRates;
}

/** Core-стеки строго по порядку запуска. */
export function coreStacks(facts: PlanFacts): readonly CoreStack[] {
  return STACKS.map((stack) => {
    const head = composeHead(facts, stack);
    const overrides = overridesOf(facts, stack);
    const up = [...head, ...overrides.flatMap((path) => ["-f", path])];
    // `--remove-orphans` не передаётся никогда: он снёс бы контейнеры
    // соседних стеков того же compose-проекта (спека).
    up.push("up", "-d", "--force-recreate");
    return {
      step: {
        name: stack.name,
        argv: up as [string, ...string[]],
        cwd: facts.configDir,
      },
      servicesArgv: [...head, "config", "--services"],
      overrides,
      migrations: stack.migrations,
      rates: stack.rates,
    };
  });
}

/**
 * Печатаемая строка шага: `$ [K=V …] <команда>` плюс комментарий, если
 * есть. Значение квотируется отдельно от имени: `'K=v w'` шелл принял
 * бы за имя команды.
 */
export function stepLine(step: Step): string {
  const env = Object.entries(step.env ?? {})
    .map(([name, value]) => `${name}=${quoteArg(value)} `)
    .join("");
  const command = `$ ${env}${shellCommand(step.argv)}`;
  return step.comment === undefined ? command : `${command}  ${step.comment}`;
}
