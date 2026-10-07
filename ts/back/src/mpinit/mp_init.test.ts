/**
 * Команда `mpu mp-init` (`docs/specs/mp-init.md`): последовательность
 * шагов, сухой прогон против эталона канала, probe'ы и fail-fast.
 *
 * Живого docker здесь нет: запуск подменён функцией, отвечающей по
 * argv. Это единственный способ проверить порядок шагов — а порядок и
 * есть контракт команды.
 *
 * Голден сверяется побайтно: домашний каталог в фикстуре ASCII, и
 * shell-квотированию нечего добавлять (кириллический путь брался бы в
 * кавычки, и сверка ловила бы квотирование вместо контракта —
 * фикстура исправлена 2026-08-28).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { configDirOf, localStackDirOf, runMpInit } from "./cmd_mp_init.ts";
import type { Clock, Docker, ProcessOutcome, RunInput } from "./docker.ts";
import { CONFLICTING, coreStacks, type PlanFacts, stepLine } from "./plan.ts";

const HOME = "/home/operator";
const CONFIG = `${HOME}/mr/mp/mp-config-local`;
const LOCAL_STACK = `${HOME}/mr/mp/local-stack`;
const ROOT = `${HOME}/mr/mp`;
const DOCKER_CONFIG = `${HOME}/.docker/config.json`;
const DOT_ENV = `${LOCAL_STACK}/.env`;
/** Синтетический пароль Nexus: его не должно быть ни в одном выводе. */
const PASSWORD = "Zz9-secret-pw";
const NPM_AUTH = btoa(`robot:${PASSWORD}`);
/**
 * Тег зависимостей sw-back синтетических файлов стенда — снят
 * `cat Dockerfile.deps package.json package-lock.json .npmrc | sha256sum`.
 */
const DEPS_TAG = "a936a86f871f592b";
const ok: ProcessOutcome = { code: 0, stdout: "", stderr: "" };
const OZON_LOCK = `${ROOT}/ozon/pnpm-lock.yaml`;
/**
 * Выдержка `ozon/pnpm-lock.yaml`, снятая 2026-09-26 дословно: ключ
 * секции `packages` и ключ секции `snapshots` с пирами — второй
 * версию не даёт.
 */
const LOCK_EXCERPT = `packages:
  '@sw-back/workspace-access@0.4.0':
    resolution: {integrity: sha512-5nxLCKc5nvb9bqmzqYKQoRf4907ADSdcIpbLsjDZvwLeelCEHKmCXmZls5/0Ghk+AB6gOIQ4t3bnZmom1qQzkA==}
    engines: {node: '>=18'}

snapshots:
  '@sw-back/workspace-access@0.4.0(@nestjs/common@11.1.28(reflect-metadata@0.2.2)(rxjs@7.8.2)(supports-color@8.1.1))':
    optionalDependencies:
      '@nestjs/common': 11.1.28(reflect-metadata@0.2.2)(rxjs@7.8.2)(supports-color@8.1.1)
`;

/** Ответ подменного docker'а; `undefined` — ответ стенда по умолчанию. */
type Answer = (
  argv: readonly string[],
  signal?: AbortSignal,
) => ProcessOutcome | Promise<ProcessOutcome> | undefined;

/** Все сервисы override-фикстур: compose стенда их знает. */
const COMPOSE_SERVICES = [
  "cli",
  "migrations",
  "backups",
  "internal-api",
  "api",
  "ss-jobs",
  "currencies-rates-parser",
  "i-clients-migrations",
  "i-internal-api",
  "currency-rates-sync",
  "support-jobs",
  "data-processor",
  "ss-loader",
  "ss-updater",
  "wb-loader",
  "ozon-loader",
  "i-wb-unit-calc-worker",
];

/** Тело здоровья sl-0 со здоровой базой — форма снята 2026-09-26. */
const HEALTHY = '{"status":"healthy","checks":{"database":{"status":"ok",' +
  '"message":"Database connected"}}}';

/** Проба курсов валют: счёт `shared.currency_rates` на sl-0. */
function isRatesProbe(argv: readonly string[]): boolean {
  return argv.at(-1)?.includes("shared.currency_rates") ?? false;
}

/**
 * Ответ поднятого стенда: всё есть, всё запущено, миграции прошли (183),
 * сводке жаловаться не на что.
 */
function standAnswer(argv: readonly string[]): ProcessOutcome {
  const out = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  if (argv.includes("{{.State.Running}}")) return out("true\n");
  if (argv.includes("{{json .NetworkSettings.Networks}}")) {
    return out('{"local-stack-sw-db-net":{"IPAddress":"172.30.0.2"}}\n');
  }
  if (argv.includes("--services")) return out(COMPOSE_SERVICES.join("\n"));
  if (argv[1] === "wait") return out("0\n");
  if (isRatesProbe(argv)) return out("8178\n");
  if (argv[1] === "exec") return out("183\n");
  if (argv[0] === "curl") return out(`${HEALTHY}\n200`);
  return ok;
}

/** Подменный docker: пишет вызовы и отвечает `answer`, иначе — как стенд. */
class FakeDocker implements Docker {
  readonly probes: string[][] = [];
  readonly runs: string[][] = [];
  /** Окружение и stdin каждого `run` — по индексу `runs`. */
  readonly inputs: (RunInput | undefined)[] = [];
  readonly watches: string[][] = [];

  constructor(private readonly answer: Answer = () => undefined) {}

  async probe(argv: readonly string[], _cwd: string, signal?: AbortSignal) {
    this.probes.push([...argv]);
    return await this.answer(argv, signal) ?? standAnswer(argv);
  }

  async run(argv: readonly string[], _cwd: string, input?: RunInput) {
    this.runs.push([...argv]);
    this.inputs.push(input);
    return (await this.answer(argv) ?? standAnswer(argv)).code;
  }

  async watch(argv: readonly string[]) {
    this.watches.push([...argv]);
    return await this.answer(argv) ?? standAnswer(argv);
  }
}

/** Часы, срок которых не наступает: `wait` отвечает раньше. */
const neverClock: Clock = {
  delay: (_ms, signal) =>
    new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    ),
};

/** Override-фикстура по имени файла — вместо чтения диска стенда. */
function readFixture(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return readFileSync(
    new URL(`./testdata/mp-init/overrides/${name}`, import.meta.url),
    "utf8",
  );
}

/**
 * Файлы стенда, которые команда читает сама: вход в Nexus, чекаут
 * sw-back (тег зависимостей), env-файлы local-stack. `$L/.env` нет.
 * Env-файлы — не по порядку имён: порядок наводит команда.
 */
const STAND_FILES: Readonly<Record<string, string>> = {
  [DOCKER_CONFIG]: '{"auths":{"nexus.btlz-api.ru":{"auth":"eDp5"}}}\n',
  [`${ROOT}/sw-back/Dockerfile.deps`]: "FROM node:22-alpine\n",
  [`${ROOT}/sw-back/package.json`]: '{"name":"sw-back"}\n',
  [`${ROOT}/sw-back/package-lock.json`]: '{"lockfileVersion":3}\n',
  [`${ROOT}/sw-back/.npmrc`]: "registry=https://registry.npmjs.org/\n",
  [`${LOCAL_STACK}/env/sw-back.env`]: "",
  [`${LOCAL_STACK}/env/sl-base.env`]: "",
  [`${LOCAL_STACK}/env/shared.env`]: "",
  [`${LOCAL_STACK}/env/README.md`]: "",
  [`${LOCAL_STACK}/env/sl-1.env`]: "",
  [`${LOCAL_STACK}/env/sl-0.env`]: "",
  [OZON_LOCK]: LOCK_EXCERPT,
};

/** Правки файлов стенда: `null` — файла нет. */
type FileEdits = Readonly<Record<string, string | null>>;

/** Чтение файлов стенда; чего нет — исключение с `code: "ENOENT"`, как у `node:fs`. */
function standReader(edits: FileEdits = {}) {
  const files: Record<string, string | null> = { ...STAND_FILES, ...edits };
  const readText = (path: string): string => {
    const text = files[path];
    if (text === null) {
      throw Object.assign(new Error(`нет файла ${path}`), { code: "ENOENT" });
    }
    return text ?? readFixture(path);
  };
  return {
    readText,
    readBytes: (path: string) => new TextEncoder().encode(readText(path)),
    listDir: (dir: string) =>
      Object.keys(files).filter((path) =>
        files[path] !== null && path.startsWith(`${dir}/`) &&
        !path.slice(dir.length + 1).includes("/")
      ).map((path) => path.slice(dir.length + 1)),
  };
}

/** Существуют все пути, кроме опционального `.sl-dt.env` стенда. */
const existsExceptDtEnv = (path: string) => !path.endsWith(".sl-dt.env");

/** io с домашним каталогом и накоплением служебных строк. */
function ioWith(lines: string[], env: Record<string, string> = {}) {
  return makeFakeIo({
    env: (name: string) => ({ HOME, ...env })[name],
    progress: (line: string) => void lines.push(line),
  });
}

/** Прогон на подменном стенде. */
async function mpInit(
  dryRun: boolean,
  lines: string[],
  docker: Docker = new FakeDocker(),
  more: {
    exists?: (path: string) => boolean;
    clock?: Clock;
    env?: Record<string, string>;
    files?: FileEdits;
  } = {},
) {
  return await runMpInit({ "dry-run": dryRun }, ioWith(lines, more.env), {
    docker,
    clock: more.clock ?? neverClock,
    exists: more.exists ?? existsExceptDtEnv,
    ...standReader(more.files),
  });
}

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/mp-init/${name}`, import.meta.url),
    "utf8",
  );
}

/** Инфры SW нет: `mp-sw-pg` и `redis-dev` не существуют. */
const noInfra: Answer = (argv) =>
  argv.includes("{{json .NetworkSettings.Networks}}")
    ? { code: 1, stdout: "", stderr: "Error: No such object" }
    : undefined;

/** Ответ «образа нет» на inspect одного тега. */
const noImage = (tag: string): Answer => (argv) =>
  argv[1] === "image" && argv[3] === tag
    ? { code: 1, stdout: "", stderr: "" }
    : undefined;

it("сухой прогон печатает последовательность — эталон канала", async () => {
  const lines: string[] = [];
  const docker = new FakeDocker();
  const result = await mpInit(true, lines, docker);

  expect(`${lines.join("\n")}\n`).toStrictEqual(await golden("dry-run.stdout"));
  expect(result.exitCode).toBe(0);
  // Ни одной мутации: в dry-run выполняются только probe'ы.
  expect(docker.runs).toStrictEqual([]);
  // Контейнеров в dry нет: ни wait миграций, ни счёта, ни сводки.
  // Проба курсов — исключение спеки (M2-3): она идёт и в dry.
  // Пробы стенда ozon (`npm view`) — тоже исключение: они в ozon-dev.
  expect(
    docker.probes.filter((argv) =>
      ["wait", "exec", "ps"].includes(argv[1]) && !isRatesProbe(argv) &&
      argv[2] !== "ozon-dev"
    ),
  ).toStrictEqual([]);
  // Проверки ответом в dry нет (M4-8).
  expect(docker.probes.filter((argv) => argv[0] === "curl")).toStrictEqual([]);
});

it("порядок шагов: web после core, стенд ozon после web", async () => {
  const lines: string[] = [];
  // Инфра не в сети и входа нет — видны все шаги web-части (M3).
  await mpInit(true, lines, new FakeDocker(noInfra), {
    files: { [DOCKER_CONFIG]: null, [DOT_ENV]: `NPM_AUTH=${NPM_AUTH}\n` },
  });
  const names = lines.filter((line) => line.startsWith("$ ")).map((line) => {
    if (line.includes("compose.mp-nats")) return "nats";
    if (line.includes("compose.sl-main")) return "sl-0";
    if (line.includes("compose.sl-instance")) return "sl-1";
    if (line.includes("compose.mp-nginx")) return "nginx";
    if (line.includes("compose.sl-dt-host")) return "dt-host";
    if (line.startsWith("$ docker stop")) return "stop";
    if (line.includes("compose.sw-infra")) return "sw-infra";
    if (line.includes("docker login")) return "login";
    if (line.includes("local-stack/docker-compose.yml")) return "web";
    if (line.includes("ozon/docker-compose.yml up -d pg")) return "ozon-infra";
    if (line.includes("migrate run")) return "ozon-migrate";
    if (line.includes("ozon/docker-compose.yml up -d datacore")) {
      return "ozon-services";
    }
    return "прочее";
  });
  // Compose-зависимостей между стеками нет: корректность стенда
  // держится ровно на этом порядке (`mp-init.md`, «Инварианты»).
  expect(names).toStrictEqual([
    "nats",
    "sl-0",
    "sl-1",
    "nginx",
    "dt-host",
    "stop",
    "sw-infra",
    "login",
    "web",
    "ozon-infra",
    "ozon-migrate",
    "ozon-services",
  ]);
});

describe("образы: недостающий core собирается, web предупреждает", () => {
  it("M1-1: dry — строки сборки, сборки нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noImage("mp-back:local"));
    const result = await mpInit(true, lines, docker);
    expect(`${lines.join("\n")}\n`).toStrictEqual(
      await golden("dry-run-no-image.stdout"),
    );
    expect(result.exitCode).toBe(0);
    expect(docker.runs).toStrictEqual([]);
  });

  it("M1-2: прогон — сборка выполнена, затем стеки", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noImage("mp-back:local"));
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines[0]).toBe("собираю mp-back:local");
    // Сборка — выполненный шаг: она и в поле результата.
    expect(result.steps[0].startsWith("$ docker build")).toBe(true);
    expect(docker.runs[0]).toStrictEqual([
      "docker",
      "build",
      "--load",
      "-t",
      "mp-back:local",
      "-f",
      `${CONFIG}/Dockerfile.mp-back`,
      `${HOME}/mr/mp`,
    ]);
    expect(docker.runs[1].includes(`${CONFIG}/compose.mp-nats.yaml`)).toBe(
      true,
    );
  });

  it("M1-3: сборка падает — её rc наружу, стеки стоят", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (argv[1] === "build") return { code: 17, stdout: "", stderr: "" };
      return noImage("mp-pg:local")(argv);
    });
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(17);
    expect(lines.slice(0, 3)).toStrictEqual([
      "собираю mp-pg:local",
      `$ docker build --load -t mp-pg:local -f ${CONFIG}/pg/Dockerfile ` +
      `${CONFIG}/pg`,
      "mpu mp-init: сборка mp-pg:local упала (rc=17)",
    ]);
    expect(docker.runs.some((argv) => argv.includes("up"))).toBe(false);
  });

  it("M1-4: все образы есть — строк сборки нет", async () => {
    const lines: string[] = [];
    await mpInit(true, lines);
    expect(lines.some((line) => line.startsWith("собираю"))).toBe(false);
  });

  it("mp-dt: контекст — корень mp", async () => {
    const lines: string[] = [];
    await mpInit(true, lines, new FakeDocker(noImage("mp-dt:local")));
    expect(lines[1]).toStrictEqual(
      `$ docker build --load -t mp-dt:local -f ` +
        `${CONFIG}/Dockerfile.mp-data-transfer ${HOME}/mr/mp`,
    );
  });

  it("M3-12: нет web-образа — собирается до web", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noImage("sl-front-dev:local"));
    const result = await mpInit(true, lines, docker);
    expect(result.exitCode).toBe(0);
    const at = lines.indexOf("собираю sl-front-dev:local");
    expect(lines[at + 1]).toStrictEqual(
      `$ docker build --load --target dev -t sl-front-dev:local ` +
        `-f ${CONFIG}/Dockerfile.front ${ROOT}/sl-front`,
    );
    const web = lines.findIndex((line) =>
      line.includes("local-stack/docker-compose.yml")
    );
    expect(0 <= at && at < web, lines.join("\n")).toBe(true);
    expect(lines.some((line) => line.startsWith("warning:"))).toBe(false);
    expect(docker.runs).toStrictEqual([]);
  });

  it("нет local-stack — web-образ не смотрится", async () => {
    const docker = new FakeDocker(noImage("sl-front-dev:local"));
    const lines: string[] = [];
    await mpInit(true, lines, docker, {
      exists: (path) => !path.includes("local-stack"),
    });
    expect(lines.some((line) => line.includes("sl-front-dev"))).toBe(false);
    expect(docker.probes.some((argv) => argv.includes("sl-front-dev:local")))
      .toBe(false);
  });
});

describe("overrides сверяются с compose до up", () => {
  const SL_MAIN = `${LOCAL_STACK}/overrides/sl-main.observability-off.yaml`;

  it("M1-5: лишний сервис — отказ, печать обрывается", async () => {
    const lines: string[] = [];
    const result = await runMpInit({ "dry-run": true }, ioWith(lines), {
      docker: new FakeDocker(),
      clock: neverClock,
      exists: existsExceptDtEnv,
      ...standReader(),
      readText: (path) =>
        path === SL_MAIN
          ? `${readFixture(path)}  m-nats-listeners:\n    image: x\n`
          : readFixture(path),
    });
    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)).toStrictEqual(
      `mpu mp-init: override ${SL_MAIN}: нет в compose: m-nats-listeners`,
    );
    expect(lines.some((line) => line.includes("compose.mp-nats"))).toBe(true);
    expect(lines.some((line) => line.includes("compose.sl-main"))).toBe(false);
  });

  it("config --services упал — отказ с его rc", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("--services") &&
        argv.includes(`${CONFIG}/compose.sl-main.yaml`)
        ? { code: 15, stdout: "", stderr: "" }
        : undefined
    );
    const result = await mpInit(true, lines, docker);
    expect(result.exitCode).toBe(15);
    expect(lines.at(-1)).toBe(
      "mpu mp-init: compose config стека 'sl-0' упал (rc=15)",
    );
  });

  it("config --services — те же -f без overrides", async () => {
    const docker = new FakeDocker();
    await mpInit(true, [], docker);
    const config = docker.probes.filter((argv) => argv.includes("--services"));
    // Только стеки с overrides: sl-0 и sl-1.
    expect(config.length).toBe(2);
    expect(config[0].slice(-2)).toStrictEqual(["config", "--services"]);
    expect(config[0].some((arg) => arg.includes("/overrides/"))).toBe(false);
    expect(config[0].includes(`${CONFIG}/.sl-0.base.env`)).toBe(true);
  });
});

describe("миграции sl-N проверяются по коду контейнера", () => {
  it("M1-6: код 1 — отказ, хвост лога, sl-1 стоит", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (argv[1] === "wait" && argv[2] === "sl-0-migrations") {
        return { code: 0, stdout: "1\n", stderr: "" };
      }
      if (argv[1] === "logs" && argv.includes("30")) {
        return { code: 0, stdout: "", stderr: "Error: relation x\n" };
      }
      return undefined;
    });
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(1);
    expect(lines.slice(-2)).toStrictEqual([
      "mpu mp-init: миграции sl-0 упали",
      "Error: relation x",
    ]);
    expect(docker.probes.find((argv) => argv[1] === "logs")).toStrictEqual([
      "docker",
      "logs",
      "--tail",
      "30",
      "sl-0-migrations",
    ]);
    expect(lines.some((line) => line.includes("compose.sl-instance"))).toBe(
      false,
    );
  });

  it("M1-7: код 0 — строка с числом миграций", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines.includes("sl-0: миграции ок, 183 в public.migrations")).toBe(
      true,
    );
    expect(lines.includes("sl-1: миграции ок, 183 в public.migrations")).toBe(
      true,
    );
    expect(docker.probes.find((argv) => argv[1] === "exec")).toStrictEqual([
      "docker",
      "exec",
      "sl-0-pg",
      "sh",
      "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc ' +
      '"select count(*) from public.migrations"',
    ]);
  });

  it("счёт не снят — «?», код не меняется", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "exec" && argv[2].endsWith("-pg")
        ? { code: 2, stdout: "", stderr: "x" }
        : undefined
    );
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines.includes("sl-0: миграции ок, ? в public.migrations")).toBe(
      true,
    );
  });

  it("M1-9: нет завершения за срок — отказ", async () => {
    const lines: string[] = [];
    let waitAborted = false;
    const docker = new FakeDocker((argv, signal) => {
      if (argv[1] !== "wait") return undefined;
      // `docker wait` не отвечает сам: только снятие сигналом.
      return new Promise((resolve) =>
        signal?.addEventListener("abort", () => {
          waitAborted = true;
          resolve({ code: 137, stdout: "", stderr: "" });
        }, { once: true })
      );
    });
    const delays: number[] = [];
    const clock: Clock = {
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    };
    const result = await mpInit(false, lines, docker, { clock });
    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)).toBe(
      "mpu mp-init: миграции sl-0: нет завершения за 10 мин",
    );
    expect(delays).toStrictEqual([10 * 60 * 1000]);
    expect(waitAborted).toBe(true);
    expect(lines.some((line) => line.includes("compose.sl-instance"))).toBe(
      false,
    );
  });

  it("docker wait сам упал — отказ, проверки не было", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "wait" ? { code: 1, stdout: "", stderr: "" } : undefined
    );
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)).toBe(
      "mpu mp-init: миграции sl-0: docker wait упал (rc=1)",
    );
  });
});

describe("сводка контейнеров после core", () => {
  const PS = [
    "sl-0-currencies-rates-parser\tRestarting (1) 3 seconds ago",
    "sl-0-migrations\tExited (1) 1 minute ago",
    "sl-0-backups\tExited (0) 1 minute ago",
    "sl-1-ss-loader\tExited (137) 5 minutes ago",
    "sl-0-api\tUp 2 minutes",
    "",
  ].join("\n");
  const troubled: Answer = (argv) => {
    if (argv[1] === "ps") return { code: 0, stdout: PS, stderr: "" };
    if (argv[1] === "logs" && argv.includes("1")) {
      return {
        code: 0,
        stdout: "",
        stderr: `ERR_MODULE_NOT_FOUND ${argv.at(-1)}\n`,
      };
    }
    return undefined;
  };

  it("M1-8: петля и выход с ошибкой — warning, код 0", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(troubled);
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines.filter((line) => line.startsWith("warning:"))).toStrictEqual([
      "warning: sl-0-currencies-rates-parser: Restarting — " +
      "ERR_MODULE_NOT_FOUND sl-0-currencies-rates-parser",
      "warning: sl-1-ss-loader: Exited (137) — " +
      "ERR_MODULE_NOT_FOUND sl-1-ss-loader",
    ]);
    expect(docker.probes.find((argv) => argv[1] === "ps")).toStrictEqual([
      "docker",
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project.working_dir=${CONFIG}`,
      "--format",
      "{{.Names}}\t{{.Status}}",
    ]);
  });

  it("сводка — после dt-host, до web", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(troubled));
    const dtHost = lines.findIndex((line) =>
      line.includes("compose.sl-dt-host")
    );
    const warning = lines.findIndex((line) => line.startsWith("warning: sl-0"));
    const web = lines.findIndex((line) =>
      line.includes("local-stack/docker-compose.yml")
    );
    expect(dtHost < warning && warning < web, lines.join("\n")).toBe(true);
  });

  it("ps упал — предупреждение, код 0", async () => {
    const lines: string[] = [];
    const result = await mpInit(
      false,
      lines,
      new FakeDocker((argv) =>
        argv[1] === "ps" ? { code: 1, stdout: "", stderr: "" } : undefined
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(lines.includes("warning: сводка контейнеров не снята (rc=1)")).toBe(
      true,
    );
  });
});

describe("сеть и том создаются только при отсутствии", () => {
  const missingProbe = (what: string): Answer => (argv) =>
    argv[1] === what && argv[2] === "inspect"
      ? { code: 1, stdout: "", stderr: "" }
      : undefined;

  it("есть — команда создания не печатается", async () => {
    const lines: string[] = [];
    await mpInit(false, lines);
    expect(lines.some((line) => line.includes("network create"))).toBe(false);
    expect(lines.some((line) => line.includes("volume create"))).toBe(false);
  });

  it("нет сети — создаётся с подсетью спеки", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(missingProbe("network")));
    // Форма строки — часть контракта вывода: `--subnet=…` одним
    // токеном, как в спеке (шаг 1).
    expect(lines[0]).toStrictEqual(
      "$ docker network create --driver=bridge mp-shared-net " +
        "--subnet=178.20.0.0/16",
    );
  });

  it("нет тома — создаётся", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(missingProbe("volume")));
    expect(lines[0]).toBe("$ docker volume create mp-back-node-modules");
  });
});

describe("стоп конфликтующих: в прогоне только запущенные", () => {
  it("запущен один из трёх — гасится он один", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("{{.State.Running}}")
        ? {
          code: 0,
          stdout: argv.at(-1) === "nextjs-dev" ? "true\n" : "false\n",
          stderr: "",
        }
        : undefined
    );
    await mpInit(false, lines, docker);
    expect(lines.filter((line) => line.startsWith("$ docker stop")))
      .toStrictEqual(["$ docker stop nextjs-dev  # только запущенные"]);
  });

  it("не запущен никто — шага нет вовсе", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("{{.State.Running}}")
        ? { code: 0, stdout: "false\n", stderr: "" }
        : undefined
    );
    await mpInit(false, lines, docker);
    expect(lines.some((line) => line.startsWith("$ docker stop"))).toBe(false);
  });

  it("в сухом прогоне печатается весь список", async () => {
    const lines: string[] = [];
    await mpInit(true, lines);
    expect(lines.filter((line) => line.startsWith("$ docker stop")))
      .toStrictEqual([
        `$ docker stop ${CONFLICTING.join(" ")}  # только запущенные`,
      ]);
  });
});

it("упавший стек: fail-fast и код docker наружу", async () => {
  const lines: string[] = [];
  const docker = new FakeDocker((argv) =>
    argv.includes("up") && argv.some((a) => a.includes("compose.sl-main"))
      ? { code: 17, stdout: "", stderr: "" }
      : undefined
  );
  const result = await mpInit(false, lines, docker);
  expect(result.exitCode).toBe(17);
  expect(lines.at(-1)).toBe(
    "mpu mp-init: стек 'sl-0' упал (rc=17); остальные не поднимаю",
  );
  // Следующие стеки не поднимались, миграций упавшего не ждали.
  expect(lines.some((line) => line.includes("compose.sl-instance"))).toBe(
    false,
  );
  expect(docker.probes.some((argv) => argv[1] === "wait")).toBe(false);
});

it("web-часть: нет каталога — пропуск, а не ошибка", async () => {
  const lines: string[] = [];
  const result = await mpInit(false, lines, new FakeDocker(), {
    exists: (path) => !path.includes("local-stack"),
  });
  expect(result.exitCode).toBe(0);
  expect(result.web).toBe(false);
  // Строка про пропуск печатается на своём шаге — после core, а не в
  // начале: «пропущено» до единой поднятой строки читалось бы как
  // «ничего не делаю».
  const skipped = lines.indexOf(
    `каталог local-stack не найден: ${LOCAL_STACK}; web-стек пропущен`,
  );
  expect(skipped > 0, lines.join("\n")).toBe(true);
  // Compose стенда ozon живёт в local-stack: без него нет и стенда.
  expect(lines[skipped + 1]).toStrictEqual(
    `стенд ozon: каталога ${LOCAL_STACK} нет — пропуск`,
  );
  expect(lines[0].includes("compose.mp-nats"), lines[0]).toBe(true);
  expect(lines.some((line) => line.includes("docker-compose.yml"))).toBe(false);
  // БД-зависимости sw-back тоже не поднимаются: их шаг — часть web.
  expect(lines.some((line) => line.includes("local-stack/docker-compose.yml")))
    .toBe(false);
  expect(lines.at(-1)).toBe(
    "mp-init: core поднят — nats, sl-0, sl-1, nginx, dt-host",
  );
});

describe("каталог стенда: env старше HOME, отсутствие — exit 2", () => {
  it("MPU_MP_CONFIG_LOCAL побеждает", () => {
    const io = ioWith([], { MPU_MP_CONFIG_LOCAL: "/opt/стенд" });
    expect(configDirOf(io)).toBe("/opt/стенд");
    expect(localStackDirOf("/opt/стенд")).toBe("/opt/local-stack");
  });

  it("M2-8: хвостовой / снимается — сводка находит проект", async () => {
    const docker = new FakeDocker();
    await mpInit(false, [], docker, {
      env: { MPU_MP_CONFIG_LOCAL: "/x/mp-config-local/" },
    });
    const ps = docker.probes.find((argv) => argv[1] === "ps");
    expect(ps?.[4]).toBe(
      "label=com.docker.compose.project.working_dir=/x/mp-config-local",
    );
  });

  it("без переменной — путь от HOME", () => {
    expect(configDirOf(ioWith([]))).toStrictEqual(CONFIG);
  });

  it("каталога нет — ошибка ввода с подсказкой", async () => {
    const failure = mpInit(true, [], new FakeDocker(), { exists: () => false });
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow(
      `каталог mp-config-local не найден: ${CONFIG}`,
    );
  });
});

/** Строки всех core-стеков — по фактам диска. */
function coreLines(facts: PlanFacts): string {
  return coreStacks(facts).map((stack) => stepLine(stack.step)).join("\n");
}

it("опциональные env-файлы включаются только существующие", () => {
  const withAll = coreLines({
    configDir: CONFIG,
    localStackDir: LOCAL_STACK,
    exists: () => true,
  });
  const withoutDt = coreLines({
    configDir: CONFIG,
    localStackDir: LOCAL_STACK,
    exists: existsExceptDtEnv,
  });
  // Несуществующий env-файл в argv — отказ compose'а целиком.
  expect(withAll.includes("/.sl-dt.env")).toBe(true);
  expect(withoutDt.includes("/.sl-dt.env")).toBe(false);
  // А базовые файлы передаются всегда, даже когда их нет на диске:
  // спека относит к опциональным только `.env` и `.sl-*.env` без
  // `base`. Пропустив базовый, мы подняли бы стек на неполном наборе
  // переменных — молча и «не тем».
  const nothingExists = coreLines({
    configDir: CONFIG,
    localStackDir: LOCAL_STACK,
    exists: () => false,
  });
  for (const base of [".sl-0.base.env", ".sl-1.base.env", ".sl-dt.base.env"]) {
    expect(nothingExists.includes(`/${base}`), base).toBe(true);
  }
  // …а необязательные при этом отпали все до одного.
  for (const optional of [".env", ".sl-0.env", ".sl-1.env", ".sl-dt.env"]) {
    expect(nothingExists.includes(`/${optional} `), optional).toBe(false);
  }
  // `--remove-orphans` не передаётся никогда: он снёс бы контейнеры
  // соседних стеков того же проекта.
  expect(withAll.includes("--remove-orphans")).toBe(false);
});

it("падение создания сети: rc наружу, стеки не поднимаются", async () => {
  const lines: string[] = [];
  const docker = new FakeDocker((argv) => {
    if (argv[1] !== "network") return undefined;
    // 125 — обычный код конфликта подсети у docker.
    return { code: argv[2] === "inspect" ? 1 : 125, stdout: "", stderr: "" };
  });
  const result = await mpInit(false, lines, docker);
  // Код docker'а идёт наружу как есть: скрипт-обёртка отличает его от
  // прочих отказов (1) только по числу.
  expect(result.exitCode).toBe(125);
  expect(lines.some((line) => line.includes("up -d"))).toBe(false);
  expect(result.steps).toStrictEqual([
    "$ docker network create --driver=bridge " +
    "mp-shared-net --subnet=178.20.0.0/16",
  ]);
});

describe("курсы валют на свежем стенде", () => {
  const BACKFILL =
    "$ docker exec sl-0-cli node cli service:currenciesRatesParser backfill";
  const SYNC =
    "$ docker exec sl-1-cli node cli service:currencyRatesSync syncFullHistory";
  const FILLING = "курсы валют пусты — заполняю (~10 мин)";
  const count = (stdout: string): Answer => (argv) =>
    isRatesProbe(argv) ? { code: 0, stdout, stderr: "" } : undefined;
  const isFill = (argv: readonly string[]) =>
    argv.includes("backfill") || argv.includes("syncFullHistory");

  it("M2-1: пусто — backfill на main, затем sync", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(count("0\n"));
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    const at = lines.indexOf(FILLING);
    expect(lines.slice(at, at + 3)).toStrictEqual([FILLING, BACKFILL, SYNC]);
    expect(docker.watches.filter(isFill).length).toBe(2);
    const summary = docker.probes.findIndex((argv) => argv[1] === "ps");
    const probe = docker.probes.findIndex(isRatesProbe);
    expect(summary < probe, "проба — после сводки").toBe(true);
    const web = lines.findIndex((line) =>
      line.includes("local-stack/docker-compose.yml")
    );
    expect(at + 2 < web, "курсы — до web").toBe(true);
  });

  it("M2-2: не пусто — строка пропуска, заполнения нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines.includes("курсы валют: 8178 строк — пропуск")).toBe(true);
    expect([...docker.runs, ...docker.watches].filter(isFill)).toStrictEqual(
      [],
    );
    expect(lines.includes(FILLING)).toBe(false);
  });

  it("M2-3: dry, пусто — три строки, ничего не выполнено", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(count("0\n"));
    const result = await mpInit(true, lines, docker);
    expect(result.exitCode).toBe(0);
    const at = lines.indexOf(FILLING);
    expect(lines.slice(at, at + 3)).toStrictEqual([FILLING, BACKFILL, SYNC]);
    expect(docker.runs).toStrictEqual([]);
    expect(docker.watches).toStrictEqual([]);
    expect(docker.probes.some(isRatesProbe), "проба — и в dry").toBe(true);
  });

  it("M2-4: backfill упал — его rc, sync и web стоят", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (isRatesProbe(argv)) return { code: 0, stdout: "0\n", stderr: "" };
      if (argv.includes("backfill")) return { code: 1, stdout: "", stderr: "" };
      return undefined;
    });
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(1);
    expect(result.web).toBe(false);
    expect(lines.at(-1)).toBe(
      "mpu mp-init: курсы валют — backfill упал (rc=1); web не поднимаю",
    );
    expect(lines.includes(SYNC)).toBe(false);
    expect(
      lines.some((line) => line.includes("local-stack/docker-compose.yml")),
    ).toBe(false);
  });

  it("M2-5: пропущенные дни — одна строка на все", async () => {
    const lines: string[] = [];
    const log = [
      "backfill: 2024-03-04 ok",
      "backfill: 2024-03-05 error ECONNRESET",
      "backfill: 2024-03-06 error ECONNRESET",
      "",
    ].join("\n");
    const docker = new FakeDocker((argv) => {
      if (isRatesProbe(argv)) return { code: 0, stdout: "0\n", stderr: "" };
      if (argv.includes("backfill")) {
        return { code: 0, stdout: "", stderr: log };
      }
      return undefined;
    });
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines.filter((line) => line.startsWith("warning: курсы")))
      .toStrictEqual([
        "warning: курсы валют — пропущены дни 2024-03-05, 2024-03-06: " +
        "догнать docker exec sl-0-cli node cli " +
        "service:currenciesRatesParser loadData --date-from D --date-to D",
      ]);
  });

  it("backfill без ошибок — предупреждения нет", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(count("0\n")));
    expect(lines.some((line) => line.startsWith("warning: курсы"))).toBe(false);
  });

  it("M2-6: проба не удалась — предупреждение, web идёт", async () => {
    for (
      const answer of [{ code: 1, stdout: "", stderr: "" }, {
        code: 0,
        stdout: "psql: error\n",
        stderr: "",
      }]
    ) {
      const lines: string[] = [];
      const docker = new FakeDocker((argv) =>
        isRatesProbe(argv) ? answer : undefined
      );
      const result = await mpInit(false, lines, docker);
      expect(result.exitCode).toBe(0);
      expect(lines.includes(
        "warning: курсы валют — проба не удалась, шаг пропущен",
      )).toBe(true);
      expect(docker.watches.filter(isFill)).toStrictEqual([]);
      expect(result.web).toBe(true);
    }
  });

  it("M2-7: sync — у инстанса sl-1, не у main", async () => {
    const docker = new FakeDocker(count("0\n"));
    await mpInit(false, [], docker);
    expect(
      docker.watches.filter((argv) => argv.includes("syncFullHistory")).map((
        argv,
      ) => argv[2]),
    ).toStrictEqual(["sl-1-cli"]);
    expect(
      docker.watches.filter((argv) => argv.includes("backfill")).map((argv) =>
        argv[2]
      ),
    ).toStrictEqual(["sl-0-cli"]);
  });

  it("sync упал — его rc, web стоит", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (isRatesProbe(argv)) return { code: 0, stdout: "0\n", stderr: "" };
      if (argv.includes("syncFullHistory")) {
        return { code: 5, stdout: "", stderr: "" };
      }
      return undefined;
    });
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(5);
    expect(lines.at(-1)).toStrictEqual(
      "mpu mp-init: курсы валют — syncFullHistory sl-1 упал (rc=5); " +
        "web не поднимаю",
    );
  });
});

/** Строка web формы M3-7: окружение процесса и услуги по порядку. */
function webLine(services: string, api = "http://internal-api:5100"): string {
  return `$ SW_BACK_SRC=${ROOT}/sw-back SW_FRONT_SRC=${ROOT}/sw-front ` +
    `SL_FRONT_SRC=${ROOT}/sl-front SW_BACK_DEPS_TAG=${DEPS_TAG} ` +
    `SW_BACK_INTERNAL_API_URL=${api} docker compose ` +
    `-f ${LOCAL_STACK}/docker-compose.yml up -d --no-deps --force-recreate ` +
    services;
}

const INFRA_LINE =
  `$ docker compose --env-file ${LOCAL_STACK}/env/shared.env ` +
  `--env-file ${LOCAL_STACK}/env/sl-0.env ` +
  `--env-file ${LOCAL_STACK}/env/sl-1.env ` +
  `--env-file ${LOCAL_STACK}/env/sl-base.env ` +
  `--env-file ${LOCAL_STACK}/env/sw-back.env ` +
  `-f ${LOCAL_STACK}/infra/compose.sw-infra.yaml up -d`;

const NO_ACCESS_WARNING =
  `warning: нет входа в nexus.btlz-api.ru и NPM_AUTH в ${LOCAL_STACK}/.env ` +
  `— см. ${LOCAL_STACK}/README.md, «Nexus»; sw-back не поднимаю`;

/** Ни входа в Nexus, ни `NPM_AUTH`. */
const NO_NEXUS: FileEdits = { [DOCKER_CONFIG]: null };

/** Входа нет, `NPM_AUTH` в `$L/.env` есть. */
const WITH_NPM_AUTH: FileEdits = {
  [DOCKER_CONFIG]: null,
  [DOT_ENV]: `# Nexus\nNPM_AUTH=${NPM_AUTH}\n`,
};

describe("web поверх core: инфра SW из local-stack (M3)", () => {
  it("M3-1: инфра в сети — строк нет, проба была", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    await mpInit(true, lines, docker);
    expect(lines.some((line) => line.includes("sw-infra"))).toBe(false);
    expect(lines.some((line) => line.includes("rm -f"))).toBe(false);
    expect(
      docker.probes.filter((argv) =>
        argv.includes("{{json .NetworkSettings.Networks}}")
      ).map((argv) => argv.at(-1)),
    ).toStrictEqual(["mp-sw-pg", "redis-dev"]);
  });

  it("M3-2: не в той сети — rm -f и compose инфры", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("{{json .NetworkSettings.Networks}}") &&
        argv.at(-1) === "mp-sw-pg"
        ? { code: 0, stdout: '{"mp-config-local_ws_default":{}}\n', stderr: "" }
        : undefined
    );
    await mpInit(true, lines, docker);
    const at = lines.indexOf("$ docker rm -f mp-sw-pg redis-dev");
    expect(at >= 0, lines.join("\n")).toBe(true);
    expect(lines[at + 1]).toStrictEqual(INFRA_LINE);
  });

  it("M3-3: контейнеров нет — только compose", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noInfra);
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines.some((line) => line.includes("rm -f"))).toBe(false);
    expect(lines.includes(INFRA_LINE), lines.join("\n")).toBe(true);
    expect(docker.runs.some((argv) => argv[1] === "rm")).toBe(false);
  });

  it("инфра упала — её rc, web стоит", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.some((arg) => arg.endsWith("compose.sw-infra.yaml"))
        ? { code: 4, stdout: "", stderr: "" }
        : noInfra(argv)
    );
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(4);
    expect(result.web).toBe(false);
    expect(lines.at(-1)).toBe(
      "mpu mp-init: стек 'sw-infra' упал (rc=4); остальные не поднимаю",
    );
  });
});

describe("web поверх core: вход в Nexus (M3)", () => {
  it("M3-4: вход есть — строк входа нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    await mpInit(false, lines, docker);
    expect(lines.some((line) => line.includes("docker login"))).toBe(false);
    expect(lines.includes(webLine("sw-back sw-front sl-front"))).toBe(true);
  });

  it("M3-5: NPM_AUTH — логин, пароль только в stdin", async () => {
    for (const dryRun of [true, false]) {
      const lines: string[] = [];
      const docker = new FakeDocker();
      const result = await mpInit(dryRun, lines, docker, {
        files: WITH_NPM_AUTH,
      });
      expect(
        lines.includes(
          "$ docker login nexus.btlz-api.ru -u robot --password-stdin",
        ),
        lines.join("\n"),
      ).toBe(true);
      const everything = JSON.stringify([
        lines,
        result,
        docker.probes,
        docker.runs,
        docker.watches,
      ]);
      for (const secret of [PASSWORD, NPM_AUTH]) {
        expect(everything.includes(secret), secret).toBe(false);
      }
      const login = docker.runs.findIndex((argv) => argv[1] === "login");
      if (dryRun) {
        expect(login).toBe(-1);
        continue;
      }
      expect(docker.inputs[login]?.stdin).toStrictEqual(PASSWORD);
    }
  });

  it("M3-6: ни входа, ни NPM_AUTH — web без sw-back", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker, { files: NO_NEXUS });
    expect(result.exitCode).toBe(0);
    expect(lines.includes(NO_ACCESS_WARNING), lines.join("\n")).toBe(true);
    expect(lines.includes(webLine("sw-front sl-front"))).toBe(true);
    expect(lines.at(-1)).toStrictEqual(
      "mp-init: поднят core (nats/sl-0/sl-1/nginx/dt-host) + " +
        "web (sw-front/sl-front)",
    );
  });

  it("M3-13: вход упал — его rc, web стоит", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "login" ? { code: 5, stdout: "", stderr: "" } : undefined
    );
    const result = await mpInit(false, lines, docker, {
      files: WITH_NPM_AUTH,
    });
    expect(result.exitCode).toBe(5);
    expect(result.web).toBe(false);
    expect(lines.at(-1)).toBe(
      "mpu mp-init: вход в nexus.btlz-api.ru упал (rc=5)",
    );
    expect(docker.runs.some((argv) => argv.includes("--no-deps"))).toBe(false);
  });

  it("M3-14: NPM_AUTH без `:` — как M3-6", async () => {
    for (const auth of [btoa("robot"), "не base64"]) {
      const lines: string[] = [];
      await mpInit(false, lines, new FakeDocker(), {
        files: { [DOCKER_CONFIG]: null, [DOT_ENV]: `NPM_AUTH=${auth}\n` },
      });
      expect(lines.includes(NO_ACCESS_WARNING), auth).toBe(true);
      expect(lines.includes(webLine("sw-front sl-front")), auth).toBe(true);
    }
  });

  it("NPM_AUTH в кавычках — вход по нему", async () => {
    for (const quote of ['"', "'"]) {
      const lines: string[] = [];
      await mpInit(true, lines, new FakeDocker(), {
        files: {
          [DOCKER_CONFIG]: null,
          [DOT_ENV]: `export NPM_AUTH=${quote}${NPM_AUTH}${quote}\n`,
        },
      });
      expect(
        lines.includes(
          "$ docker login nexus.btlz-api.ru -u robot --password-stdin",
        ),
        quote,
      ).toBe(true);
    }
  });

  it("битый config.json — входа нет", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(), {
      files: { [DOCKER_CONFIG]: "{", [DOT_ENV]: null },
    });
    expect(lines.includes(NO_ACCESS_WARNING)).toBe(true);
  });
});

describe("web поверх core: тег зависимостей и web (M3)", () => {
  it("M3-7: dry — строка web с окружением и --no-deps", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    await mpInit(true, lines, docker);
    expect(lines.find((line) => line.includes("--no-deps"))).toStrictEqual(
      webLine("sw-back sw-front sl-front"),
    );
    expect(docker.probes.some((argv) =>
      argv.join(" ") ===
        "docker manifest inspect " +
          `nexus.btlz-api.ru/base-images/sw-back-deps:${DEPS_TAG}`
    )).toBe(true);
  });

  it("M3-7: прогон — окружение уходит процессу", async () => {
    const docker = new FakeDocker();
    await mpInit(false, [], docker);
    const web = docker.runs.findIndex((argv) => argv.includes("--no-deps"));
    expect(docker.runs[web].slice(0, 4)).toStrictEqual([
      "docker",
      "compose",
      "-f",
      `${LOCAL_STACK}/docker-compose.yml`,
    ]);
    expect(docker.inputs[web]?.env).toStrictEqual({
      SW_BACK_SRC: `${ROOT}/sw-back`,
      SW_FRONT_SRC: `${ROOT}/sw-front`,
      SL_FRONT_SRC: `${ROOT}/sl-front`,
      SW_BACK_DEPS_TAG: DEPS_TAG,
      SW_BACK_INTERNAL_API_URL: "http://internal-api:5100",
    });
  });

  it("M3-8: образа зависимостей нет — web без sw-back", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "manifest" ? { code: 1, stdout: "", stderr: "" } : undefined
    );
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(
      lines.includes(
        `warning: sw-back: нет образа зависимостей под этот lock (${DEPS_TAG})`,
      ),
      lines.join("\n"),
    ).toBe(true);
    expect(lines.includes(webLine("sw-front sl-front"))).toBe(true);
  });

  it("M3-9: SW_BACK_INTERNAL_API_URL из $L/.env", async () => {
    const lines: string[] = [];
    await mpInit(true, lines, new FakeDocker(), {
      files: {
        [DOT_ENV]: "SW_BACK_INTERNAL_API_URL=http://x:1 # флот\nOTHER=1\n",
      },
    });
    expect(
      lines.includes(webLine("sw-back sw-front sl-front", "http://x:1")),
      lines.join("\n"),
    ).toBe(true);
  });

  it("M3-11: web упал — его rc", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("--no-deps")
        ? { code: 3, stdout: "", stderr: "" }
        : undefined
    );
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(3);
    expect(result.web).toBe(false);
    expect(lines.at(-1)).toBe("mpu mp-init: web упал (rc=3)");
  });

  it("M3-15: нет файла для тега — web без sw-back", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker, {
      files: { [`${ROOT}/sw-back/.npmrc`]: null },
    });
    expect(result.exitCode).toBe(0);
    expect(
      lines.includes(
        `warning: sw-back: тег зависимостей не снят — нет ${ROOT}/sw-back/` +
          ".npmrc; sw-back не поднимаю",
      ),
      lines.join("\n"),
    ).toBe(true);
    const web = lines.find((line) => line.includes("--no-deps")) ?? "";
    expect(web.endsWith("--force-recreate sw-front sl-front"), web).toBe(true);
    expect(docker.probes.some((argv) => argv[1] === "manifest")).toBe(false);
  });
});

const OZON_COMPOSE = `${LOCAL_STACK}/ozon/docker-compose.yml`;
const WA = "/tmp/wa/packages/workspace-access";
/** Коммит sw-back, где версия пакета — 0.4.0, и следующий, где её сняли. */
const ADDED = "c0ffee04";
const BUMPED = "c0ffee05";

/** Строки шага 6 стенда голдена (M4-1): без публикации и установки. */
const OZON_LINES = [
  `$ docker compose -f ${OZON_COMPOSE} up -d pg redis clickhouse verdaccio dev`,
  `$ docker compose -f ${OZON_COMPOSE} --profile migrate run --rm migrate`,
  `$ docker compose -f ${OZON_COMPOSE} up -d datacore datacore-worker ingest front`,
];

/** Проба в ozon-dev: `docker exec ozon-dev <word> …`. */
const inDev = (argv: readonly string[], word: string) =>
  argv[1] === "exec" && argv[2] === "ozon-dev" && argv.includes(word);

/**
 * Пакета версии lock в Verdaccio нет; `git log -S` отдаёт оба коммита
 * (новый первым), версия есть только в `ADDED`; `dist` — `distList`.
 */
const unpublished = (distList = "index.js\n"): Answer => (argv) => {
  const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
  if (inDev(argv, "view")) return out("", 1);
  if (inDev(argv, "log")) return out(`${BUMPED}\n${ADDED}\n`);
  if (inDev(argv, "show")) {
    return out(
      `{"version": "${argv.at(-1)?.startsWith(ADDED) ? "0.4.0" : "0.5.0"}"}`,
    );
  }
  if (argv[1] === "exec" && argv.includes("ls")) return out(distList);
  if (argv.includes("tsc")) return out("", 2);
  return undefined;
};

/** Строки публикации пакета 0.4.0 из коммита `ADDED` (M4-2). */
const PUBLISH_LINES = [
  "стенд ozon: публикую @sw-back/workspace-access@0.4.0 в Verdaccio",
  "$ docker exec ozon-dev sh -c 'rm -rf /tmp/wa && mkdir /tmp/wa && " +
  `git -C /work/sw-back archive ${ADDED} packages/workspace-access | ` +
  "tar -x -C /tmp/wa'",
  `$ docker exec -w ${WA} ozon-dev npx -y -p typescript@5 tsc -p tsconfig.json`,
  `$ docker exec -w ${WA} ozon-dev npm publish --registry ` +
  "http://verdaccio:4873 --//verdaccio:4873/:_authToken=local-stand",
];

/** Ответ curl по адресу: `status` и тело; прочие — как у стенда. */
const answering = (url: string, status: string, body = ""): Answer => (argv) =>
  argv[0] === "curl" && argv.at(-1) === url
    ? { code: 0, stdout: `${body}\n${status}`, stderr: "" }
    : undefined;

describe("стенд ozon (M4)", () => {
  it("M4-1: всё на месте — три строки compose", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(true, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(lines.slice(-4, -1)).toStrictEqual(OZON_LINES);
    // Версия из lock сверена с Verdaccio — публикации нет.
    expect(docker.probes.some((argv) =>
      argv.join(" ") ===
        "docker exec ozon-dev npm view @sw-back/workspace-access@0.4.0 " +
          "--registry http://verdaccio:4873"
    )).toBe(true);
    expect(lines.some((line) => line.includes("публикую"))).toBe(false);
    expect(lines.some((line) => line.includes("pnpm"))).toBe(false);
  });

  it("M4-1: прогон — compose выполняется", async () => {
    const docker = new FakeDocker();
    await mpInit(false, [], docker);
    const ozon = docker.runs.filter((argv) => argv.includes(OZON_COMPOSE));
    expect(ozon.map((argv) => `$ ${argv.join(" ")}`)).toStrictEqual(OZON_LINES);
  });

  it("M4-2: пакета нет — строки публикации после infra", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(unpublished());
    const result = await mpInit(true, lines, docker);
    expect(result.exitCode).toBe(0);
    const infra = lines.indexOf(OZON_LINES[0]);
    expect(
      lines.slice(infra + 1, infra + 1 + PUBLISH_LINES.length),
      lines.join("\n"),
    ).toStrictEqual(PUBLISH_LINES);
    // Проба `dist` в dry не идёт: пакет не распакован.
    expect(docker.probes.some((argv) => argv.includes("ls"))).toBe(false);
  });

  it("M4-2: коммит ищется в контейнере, форма пробы", async () => {
    const docker = new FakeDocker(unpublished());
    await mpInit(true, [], docker);
    expect(docker.probes.find((argv) => inDev(argv, "log"))).toStrictEqual([
      "docker",
      "exec",
      "ozon-dev",
      "git",
      "-C",
      "/work/sw-back",
      "log",
      "--format=%H",
      '-S"version": "0.4.0"',
      "--",
      "packages/workspace-access/package.json",
    ]);
  });

  it("M4-2: прогон — код tsc не смотрится, dist есть", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(unpublished());
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode, lines.join("\n")).toBe(0);
    expect(docker.runs.some((argv) => argv.includes("publish"))).toBe(true);
  });

  it("M4-2: dist пуст — отказ 1, публикации нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(unpublished(""));
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)).toBe(
      "mpu mp-init: стенд ozon: dist пакета пуст — не публикую",
    );
    expect(docker.runs.some((argv) => argv.includes("publish"))).toBe(false);
  });

  it("M4-2: коммита с версией нет — отказ 1", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      inDev(argv, "show")
        ? { code: 0, stdout: '{"version": "0.5.0"}', stderr: "" }
        : unpublished()(argv)
    );
    const result = await mpInit(true, lines, docker);
    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)).toStrictEqual(
      "mpu mp-init: стенд ozon: нет коммита sw-back с " +
        "@sw-back/workspace-access@0.4.0",
    );
  });

  it("dry, ozon-dev не запущен — план пакета пропущен", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (argv.includes("{{.State.Running}}") && argv.at(-1) === "ozon-dev") {
        return { code: 1, stdout: "", stderr: "Error: No such object" };
      }
      return argv[2] === "ozon-dev"
        ? { code: 1, stdout: "", stderr: "Error: No such container" }
        : undefined;
    });
    const result = await mpInit(true, lines, docker);
    expect(result.exitCode, lines.join("\n")).toBe(0);
    const infra = lines.indexOf(OZON_LINES[0]);
    expect(lines[infra + 1]).toStrictEqual(
      "стенд ozon: ozon-dev не запущен — план публикации пакета не " +
        "построить (в реальном прогоне он поднимется первым)",
    );
    expect(lines.slice(-3, -1)).toStrictEqual(OZON_LINES.slice(1));
    expect(docker.probes.some((argv) => inDev(argv, "log"))).toBe(false);
  });

  it("в lock нет пакета — предупреждение, стенд дальше", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(true, lines, docker, {
      files: { [OZON_LOCK]: null },
    });
    expect(result.exitCode).toBe(0);
    expect(lines.includes(
      "warning: стенд ozon: в pnpm-lock нет @sw-back/workspace-access — " +
        "публикацию пропускаю",
    )).toBe(true);
    expect(lines.slice(-3, -1)).toStrictEqual(OZON_LINES.slice(1));
    expect(docker.probes.some((argv) => inDev(argv, "view"))).toBe(false);
  });

  it("M4-3: нет node_modules — установка и сборка", async () => {
    const lines: string[] = [];
    await mpInit(true, lines, new FakeDocker(), {
      exists: (path) =>
        existsExceptDtEnv(path) && !path.endsWith("/ozon/node_modules"),
    });
    const dev = "$ docker exec ozon-dev sh -c ";
    const pnpm = "PATH=/tmp/bin:$PATH pnpm";
    expect(lines.slice(-8, -3)).toStrictEqual([
      `${dev}'mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin'`,
      `${dev}'${pnpm} install --config.@sw-back:registry=http://verdaccio:4873'`,
      `${dev}'${pnpm} --filter "./packages/*" run build'`,
      `${dev}'${pnpm} --filter @ozon/datacore build'`,
      `${dev}'${pnpm} --filter @ozon/ingest build'`,
    ]);
    // Установка — после пакета, до миграций.
    expect(lines.at(-3)).toStrictEqual(OZON_LINES[1]);
  });

  it("M4-4: чекаута ozon нет — пропуск, код 0", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker, {
      exists: (path) =>
        existsExceptDtEnv(path) && !path.startsWith(`${ROOT}/ozon`),
    });
    expect(result.exitCode).toBe(0);
    expect(lines.includes(`стенд ozon: чекаута ${ROOT}/ozon нет — пропуск`))
      .toBe(true);
    expect(docker.runs.some((argv) => argv.includes(OZON_COMPOSE))).toBe(false);
    // Адреса стенда ozon не проверяются.
    expect(
      docker.probes.some((argv) =>
        argv[0] === "curl" && argv.at(-1)!.includes(":5200")
      ),
    ).toBe(false);
  });

  it("M4-9: up ozon упал — его rc, финала нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes(OZON_COMPOSE) && argv.includes("pg")
        ? { code: 4, stdout: "", stderr: "" }
        : undefined
    );
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(4);
    expect(lines.at(-1)).toBe("mpu mp-init: стенд ozon упал (rc=4)");
    expect(docker.probes.some((argv) => argv[0] === "curl")).toBe(false);
  });
});

describe("финал: проверка ответом (M4)", () => {
  const checks = (lines: readonly string[]) =>
    lines.filter((line) => line.includes("проверка"));

  it("M4-5: все 200 — строка на адрес, по порядку", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(checks(lines)).toStrictEqual([
      "проверка: 200 http://sw.localhost",
      "проверка: 200 http://sw.localhost/api/metrics",
      "проверка: 200 http://sl-dev.localhost",
      "проверка: 200 http://localhost:5000/api/health",
      "проверка: 200 http://localhost:5200/health",
      "проверка: 200 http://localhost:3100/ozon/app/",
    ]);
    // Проверка — до итоговой строки: та закрывает прогон.
    expect(lines.at(-2)).toBe("проверка: 200 http://localhost:3100/ozon/app/");
    // По переадресациям: `/ozon/app/` отвечает 308.
    expect(docker.probes.find((argv) => argv[0] === "curl")).toStrictEqual([
      "curl",
      "-sS",
      "-L",
      "--max-time",
      "10",
      "-w",
      "\\n%{http_code}",
      "http://sw.localhost",
    ]);
  });

  it("M4-6: 502 — предупреждение, код не меняется", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(answering("http://sw.localhost", "502"));
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(checks(lines)[0]).toBe("warning: проверка: 502 http://sw.localhost");
  });

  it("нет ответа — 000", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.at(-1) === "http://sl-dev.localhost"
        ? { code: 7, stdout: "", stderr: "curl: (7) Failed to connect" }
        : undefined
    );
    await mpInit(false, lines, docker);
    expect(checks(lines)[2]).toBe(
      "warning: проверка: 000 http://sl-dev.localhost",
    );
  });

  it("M4-7: sl-0 503 при database: ok — не отказ", async () => {
    const lines: string[] = [];
    const body = '{"status":"unhealthy","checks":{"database":{"status":"ok",' +
      '"message":"Database connected"},"memory":{"status":"warning",' +
      '"usagePercent":"96%"}}}';
    const docker = new FakeDocker(
      answering("http://localhost:5000/api/health", "503", body),
    );
    const result = await mpInit(false, lines, docker);
    expect(result.exitCode).toBe(0);
    expect(checks(lines)[3]).toBe(
      "проверка: sl-0 — 503 при database: ok (память на старте), не отказ",
    );
  });

  it("sl-0: база не ok — предупреждение", async () => {
    const lines: string[] = [];
    const body = '{"checks":{"database":{"status":"error"}}}';
    const docker = new FakeDocker(
      answering("http://localhost:5000/api/health", "503", body),
    );
    await mpInit(false, lines, docker);
    expect(checks(lines)[3]).toBe(
      "warning: проверка: 503 http://localhost:5000/api/health",
    );
  });

  it("sl-0: 200 с телом не JSON — не предупреждение", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(
      answering("http://localhost:5000/api/health", "200", "OK"),
    );
    await mpInit(false, lines, docker);
    expect(checks(lines)[3]).toBe(
      "проверка: 200 http://localhost:5000/api/health",
    );
  });

  it("M4-8: в dry проверки нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    await mpInit(true, lines, docker);
    expect(checks(lines)).toStrictEqual([]);
    expect(docker.probes.some((argv) => argv[0] === "curl")).toBe(false);
  });

  it("без sw-back — его адрес не проверяется", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "manifest" ? { code: 1, stdout: "", stderr: "" } : undefined
    );
    await mpInit(false, lines, docker);
    expect(checks(lines).some((line) => line.includes("/api/metrics"))).toBe(
      false,
    );
    expect(checks(lines).length).toBe(5);
  });
});
