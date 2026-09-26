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

import { assertEquals, assertRejects } from "@std/assert";
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
  return Deno.readTextFileSync(
    new URL(`./testdata/mp-init/overrides/${name}`, import.meta.url),
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
};

/** Правки файлов стенда: `null` — файла нет. */
type FileEdits = Readonly<Record<string, string | null>>;

/** Чтение файлов стенда; чего нет — `NotFound`, как у диска. */
function standReader(edits: FileEdits = {}) {
  const files: Record<string, string | null> = { ...STAND_FILES, ...edits };
  const readText = (path: string): string => {
    const text = files[path];
    if (text === null) throw new Deno.errors.NotFound(path);
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
  return await Deno.readTextFile(
    new URL(`./testdata/mp-init/${name}`, import.meta.url),
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

Deno.test("сухой прогон печатает последовательность — эталон канала", async () => {
  const lines: string[] = [];
  const docker = new FakeDocker();
  const result = await mpInit(true, lines, docker);

  assertEquals(`${lines.join("\n")}\n`, await golden("dry-run.stdout"));
  assertEquals(result.exitCode, 0);
  // Ни одной мутации: в dry-run выполняются только probe'ы.
  assertEquals(docker.runs, []);
  // Контейнеров в dry нет: ни wait миграций, ни счёта, ни сводки.
  // Проба курсов — исключение спеки (M2-3): она идёт и в dry.
  assertEquals(
    docker.probes.filter((argv) =>
      ["wait", "exec", "ps"].includes(argv[1]) && !isRatesProbe(argv)
    ),
    [],
  );
});

Deno.test("порядок шагов: web поднимается после core", async () => {
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
    return "прочее";
  });
  // Compose-зависимостей между стеками нет: корректность стенда
  // держится ровно на этом порядке (`mp-init.md`, «Инварианты»).
  assertEquals(names, [
    "nats",
    "sl-0",
    "sl-1",
    "nginx",
    "dt-host",
    "stop",
    "sw-infra",
    "login",
    "web",
  ]);
});

Deno.test("образы: недостающий core собирается, web предупреждает", async (t) => {
  await t.step("M1-1: dry — строки сборки, сборки нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noImage("mp-back:local"));
    const result = await mpInit(true, lines, docker);
    assertEquals(
      `${lines.join("\n")}\n`,
      await golden("dry-run-no-image.stdout"),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(docker.runs, []);
  });

  await t.step("M1-2: прогон — сборка выполнена, затем стеки", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noImage("mp-back:local"));
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    assertEquals(lines[0], "собираю mp-back:local");
    // Сборка — выполненный шаг: она и в поле результата.
    assertEquals(result.steps[0].startsWith("$ docker build"), true);
    assertEquals(docker.runs[0], [
      "docker",
      "build",
      "--load",
      "-t",
      "mp-back:local",
      "-f",
      `${CONFIG}/Dockerfile.mp-back`,
      `${HOME}/mr/mp`,
    ]);
    assertEquals(
      docker.runs[1].includes(`${CONFIG}/compose.mp-nats.yaml`),
      true,
    );
  });

  await t.step("M1-3: сборка падает — её rc наружу, стеки стоят", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (argv[1] === "build") return { code: 17, stdout: "", stderr: "" };
      return noImage("mp-pg:local")(argv);
    });
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 17);
    assertEquals(lines.slice(0, 3), [
      "собираю mp-pg:local",
      `$ docker build --load -t mp-pg:local -f ${CONFIG}/pg/Dockerfile ` +
      `${CONFIG}/pg`,
      "mpu mp-init: сборка mp-pg:local упала (rc=17)",
    ]);
    assertEquals(docker.runs.some((argv) => argv.includes("up")), false);
  });

  await t.step("M1-4: все образы есть — строк сборки нет", async () => {
    const lines: string[] = [];
    await mpInit(true, lines);
    assertEquals(lines.some((line) => line.startsWith("собираю")), false);
  });

  await t.step("mp-dt: контекст — корень mp", async () => {
    const lines: string[] = [];
    await mpInit(true, lines, new FakeDocker(noImage("mp-dt:local")));
    assertEquals(
      lines[1],
      `$ docker build --load -t mp-dt:local -f ` +
        `${CONFIG}/Dockerfile.mp-data-transfer ${HOME}/mr/mp`,
    );
  });

  await t.step("M3-12: нет web-образа — собирается до web", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noImage("sl-front-dev:local"));
    const result = await mpInit(true, lines, docker);
    assertEquals(result.exitCode, 0);
    const at = lines.indexOf("собираю sl-front-dev:local");
    assertEquals(
      lines[at + 1],
      `$ docker build --load --target dev -t sl-front-dev:local ` +
        `-f ${CONFIG}/Dockerfile.front ${ROOT}/sl-front`,
    );
    const web = lines.findIndex((line) =>
      line.includes("local-stack/docker-compose.yml")
    );
    assertEquals(0 <= at && at < web, true, lines.join("\n"));
    assertEquals(lines.some((line) => line.startsWith("warning:")), false);
    assertEquals(docker.runs, []);
  });

  await t.step("нет local-stack — web-образ не смотрится", async () => {
    const docker = new FakeDocker(noImage("sl-front-dev:local"));
    const lines: string[] = [];
    await mpInit(true, lines, docker, {
      exists: (path) => !path.includes("local-stack"),
    });
    assertEquals(lines.some((line) => line.includes("sl-front-dev")), false);
    assertEquals(
      docker.probes.some((argv) => argv.includes("sl-front-dev:local")),
      false,
    );
  });
});

Deno.test("overrides сверяются с compose до up", async (t) => {
  const SL_MAIN = `${LOCAL_STACK}/overrides/sl-main.observability-off.yaml`;

  await t.step("M1-5: лишний сервис — отказ, печать обрывается", async () => {
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
    assertEquals(result.exitCode, 1);
    assertEquals(
      lines.at(-1),
      `mpu mp-init: override ${SL_MAIN}: нет в compose: m-nats-listeners`,
    );
    assertEquals(lines.some((line) => line.includes("compose.mp-nats")), true);
    assertEquals(lines.some((line) => line.includes("compose.sl-main")), false);
  });

  await t.step("config --services упал — отказ с его rc", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("--services") &&
        argv.includes(`${CONFIG}/compose.sl-main.yaml`)
        ? { code: 15, stdout: "", stderr: "" }
        : undefined
    );
    const result = await mpInit(true, lines, docker);
    assertEquals(result.exitCode, 15);
    assertEquals(
      lines.at(-1),
      "mpu mp-init: compose config стека 'sl-0' упал (rc=15)",
    );
  });

  await t.step("config --services — те же -f без overrides", async () => {
    const docker = new FakeDocker();
    await mpInit(true, [], docker);
    const config = docker.probes.filter((argv) => argv.includes("--services"));
    // Только стеки с overrides: sl-0 и sl-1.
    assertEquals(config.length, 2);
    assertEquals(config[0].slice(-2), ["config", "--services"]);
    assertEquals(config[0].some((arg) => arg.includes("/overrides/")), false);
    assertEquals(config[0].includes(`${CONFIG}/.sl-0.base.env`), true);
  });
});

Deno.test("миграции sl-N проверяются по коду контейнера", async (t) => {
  await t.step("M1-6: код 1 — отказ, хвост лога, sl-1 стоит", async () => {
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
    assertEquals(result.exitCode, 1);
    assertEquals(lines.slice(-2), [
      "mpu mp-init: миграции sl-0 упали",
      "Error: relation x",
    ]);
    assertEquals(
      docker.probes.find((argv) => argv[1] === "logs"),
      ["docker", "logs", "--tail", "30", "sl-0-migrations"],
    );
    assertEquals(
      lines.some((line) => line.includes("compose.sl-instance")),
      false,
    );
  });

  await t.step("M1-7: код 0 — строка с числом миграций", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines.includes("sl-0: миграции ок, 183 в public.migrations"),
      true,
    );
    assertEquals(
      lines.includes("sl-1: миграции ок, 183 в public.migrations"),
      true,
    );
    assertEquals(docker.probes.find((argv) => argv[1] === "exec"), [
      "docker",
      "exec",
      "sl-0-pg",
      "sh",
      "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc ' +
      '"select count(*) from public.migrations"',
    ]);
  });

  await t.step("счёт не снят — «?», код не меняется", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "exec" ? { code: 2, stdout: "", stderr: "x" } : undefined
    );
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines.includes("sl-0: миграции ок, ? в public.migrations"),
      true,
    );
  });

  await t.step("M1-9: нет завершения за срок — отказ", async () => {
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
    assertEquals(result.exitCode, 1);
    assertEquals(
      lines.at(-1),
      "mpu mp-init: миграции sl-0: нет завершения за 10 мин",
    );
    assertEquals(delays, [10 * 60 * 1000]);
    assertEquals(waitAborted, true);
    assertEquals(
      lines.some((line) => line.includes("compose.sl-instance")),
      false,
    );
  });

  await t.step("docker wait сам упал — отказ, проверки не было", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "wait" ? { code: 1, stdout: "", stderr: "" } : undefined
    );
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 1);
    assertEquals(
      lines.at(-1),
      "mpu mp-init: миграции sl-0: docker wait упал (rc=1)",
    );
  });
});

Deno.test("сводка контейнеров после core", async (t) => {
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

  await t.step("M1-8: петля и выход с ошибкой — warning, код 0", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(troubled);
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines.filter((line) => line.startsWith("warning:")),
      [
        "warning: sl-0-currencies-rates-parser: Restarting — " +
        "ERR_MODULE_NOT_FOUND sl-0-currencies-rates-parser",
        "warning: sl-1-ss-loader: Exited (137) — " +
        "ERR_MODULE_NOT_FOUND sl-1-ss-loader",
      ],
    );
    assertEquals(docker.probes.find((argv) => argv[1] === "ps"), [
      "docker",
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project.working_dir=${CONFIG}`,
      "--format",
      "{{.Names}}\t{{.Status}}",
    ]);
  });

  await t.step("сводка — после dt-host, до web", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(troubled));
    const dtHost = lines.findIndex((line) =>
      line.includes("compose.sl-dt-host")
    );
    const warning = lines.findIndex((line) => line.startsWith("warning: sl-0"));
    const web = lines.findIndex((line) =>
      line.includes("local-stack/docker-compose.yml")
    );
    assertEquals(dtHost < warning && warning < web, true, lines.join("\n"));
  });

  await t.step("ps упал — предупреждение, код 0", async () => {
    const lines: string[] = [];
    const result = await mpInit(
      false,
      lines,
      new FakeDocker((argv) =>
        argv[1] === "ps" ? { code: 1, stdout: "", stderr: "" } : undefined
      ),
    );
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines.includes("warning: сводка контейнеров не снята (rc=1)"),
      true,
    );
  });
});

Deno.test("сеть и том создаются только при отсутствии", async (t) => {
  const missingProbe = (what: string): Answer => (argv) =>
    argv[1] === what && argv[2] === "inspect"
      ? { code: 1, stdout: "", stderr: "" }
      : undefined;

  await t.step("есть — команда создания не печатается", async () => {
    const lines: string[] = [];
    await mpInit(false, lines);
    assertEquals(lines.some((line) => line.includes("network create")), false);
    assertEquals(lines.some((line) => line.includes("volume create")), false);
  });

  await t.step("нет сети — создаётся с подсетью спеки", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(missingProbe("network")));
    // Форма строки — часть контракта вывода: `--subnet=…` одним
    // токеном, как в спеке (шаг 1).
    assertEquals(
      lines[0],
      "$ docker network create --driver=bridge mp-shared-net " +
        "--subnet=178.20.0.0/16",
    );
  });

  await t.step("нет тома — создаётся", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(missingProbe("volume")));
    assertEquals(lines[0], "$ docker volume create mp-back-node-modules");
  });
});

Deno.test("стоп конфликтующих: в прогоне только запущенные", async (t) => {
  await t.step("запущен один из трёх — гасится он один", async () => {
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
    assertEquals(
      lines.filter((line) => line.startsWith("$ docker stop")),
      ["$ docker stop nextjs-dev  # только запущенные"],
    );
  });

  await t.step("не запущен никто — шага нет вовсе", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("{{.State.Running}}")
        ? { code: 0, stdout: "false\n", stderr: "" }
        : undefined
    );
    await mpInit(false, lines, docker);
    assertEquals(lines.some((line) => line.startsWith("$ docker stop")), false);
  });

  await t.step("в сухом прогоне печатается весь список", async () => {
    const lines: string[] = [];
    await mpInit(true, lines);
    assertEquals(
      lines.filter((line) => line.startsWith("$ docker stop")),
      [`$ docker stop ${CONFLICTING.join(" ")}  # только запущенные`],
    );
  });
});

Deno.test("упавший стек: fail-fast и код docker наружу", async () => {
  const lines: string[] = [];
  const docker = new FakeDocker((argv) =>
    argv.includes("up") && argv.some((a) => a.includes("compose.sl-main"))
      ? { code: 17, stdout: "", stderr: "" }
      : undefined
  );
  const result = await mpInit(false, lines, docker);
  assertEquals(result.exitCode, 17);
  assertEquals(
    lines.at(-1),
    "mpu mp-init: стек 'sl-0' упал (rc=17); остальные не поднимаю",
  );
  // Следующие стеки не поднимались, миграций упавшего не ждали.
  assertEquals(
    lines.some((line) => line.includes("compose.sl-instance")),
    false,
  );
  assertEquals(docker.probes.some((argv) => argv[1] === "wait"), false);
});

Deno.test("web-часть: нет каталога — пропуск, а не ошибка", async () => {
  const lines: string[] = [];
  const result = await mpInit(false, lines, new FakeDocker(), {
    exists: (path) => !path.includes("local-stack"),
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.web, false);
  // Строка про пропуск печатается на своём шаге — после core, а не в
  // начале: «пропущено» до единой поднятой строки читалось бы как
  // «ничего не делаю».
  assertEquals(
    lines.at(-2),
    `каталог local-stack не найден: ${LOCAL_STACK}; web-стек пропущен`,
  );
  assertEquals(lines[0].includes("compose.mp-nats"), true, lines[0]);
  assertEquals(
    lines.some((line) => line.includes("docker-compose.yml")),
    false,
  );
  // БД-зависимости sw-back тоже не поднимаются: их шаг — часть web.
  assertEquals(
    lines.some((line) => line.includes("local-stack/docker-compose.yml")),
    false,
  );
  assertEquals(
    lines.at(-1),
    "mp-init: core поднят — nats, sl-0, sl-1, nginx, dt-host",
  );
});

Deno.test("каталог стенда: env старше HOME, отсутствие — exit 2", async (t) => {
  await t.step("MPU_MP_CONFIG_LOCAL побеждает", () => {
    const io = ioWith([], { MPU_MP_CONFIG_LOCAL: "/opt/стенд" });
    assertEquals(configDirOf(io), "/opt/стенд");
    assertEquals(localStackDirOf("/opt/стенд"), "/opt/local-stack");
  });

  await t.step(
    "M2-8: хвостовой / снимается — сводка находит проект",
    async () => {
      const docker = new FakeDocker();
      await mpInit(false, [], docker, {
        env: { MPU_MP_CONFIG_LOCAL: "/x/mp-config-local/" },
      });
      const ps = docker.probes.find((argv) => argv[1] === "ps");
      assertEquals(
        ps?.[4],
        "label=com.docker.compose.project.working_dir=/x/mp-config-local",
      );
    },
  );

  await t.step("без переменной — путь от HOME", () => {
    assertEquals(configDirOf(ioWith([])), CONFIG);
  });

  await t.step("каталога нет — ошибка ввода с подсказкой", async () => {
    await assertRejects(
      () => mpInit(true, [], new FakeDocker(), { exists: () => false }),
      UsageError,
      `каталог mp-config-local не найден: ${CONFIG}`,
    );
  });
});

/** Строки всех core-стеков — по фактам диска. */
function coreLines(facts: PlanFacts): string {
  return coreStacks(facts).map((stack) => stepLine(stack.step)).join("\n");
}

Deno.test("опциональные env-файлы включаются только существующие", () => {
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
  assertEquals(withAll.includes("/.sl-dt.env"), true);
  assertEquals(withoutDt.includes("/.sl-dt.env"), false);
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
    assertEquals(nothingExists.includes(`/${base}`), true, base);
  }
  // …а необязательные при этом отпали все до одного.
  for (const optional of [".env", ".sl-0.env", ".sl-1.env", ".sl-dt.env"]) {
    assertEquals(
      nothingExists.includes(`/${optional} `),
      false,
      optional,
    );
  }
  // `--remove-orphans` не передаётся никогда: он снёс бы контейнеры
  // соседних стеков того же проекта.
  assertEquals(withAll.includes("--remove-orphans"), false);
});

Deno.test("падение создания сети: rc наружу, стеки не поднимаются", async () => {
  const lines: string[] = [];
  const docker = new FakeDocker((argv) => {
    if (argv[1] !== "network") return undefined;
    // 125 — обычный код конфликта подсети у docker.
    return { code: argv[2] === "inspect" ? 1 : 125, stdout: "", stderr: "" };
  });
  const result = await mpInit(false, lines, docker);
  // Код docker'а идёт наружу как есть: скрипт-обёртка отличает его от
  // прочих отказов (1) только по числу.
  assertEquals(result.exitCode, 125);
  assertEquals(lines.some((line) => line.includes("up -d")), false);
  assertEquals(result.steps, [
    "$ docker network create --driver=bridge " +
    "mp-shared-net --subnet=178.20.0.0/16",
  ]);
});

Deno.test("курсы валют на свежем стенде", async (t) => {
  const BACKFILL =
    "$ docker exec sl-0-cli node cli service:currenciesRatesParser backfill";
  const SYNC =
    "$ docker exec sl-1-cli node cli service:currencyRatesSync syncFullHistory";
  const FILLING = "курсы валют пусты — заполняю (~10 мин)";
  const count = (stdout: string): Answer => (argv) =>
    isRatesProbe(argv) ? { code: 0, stdout, stderr: "" } : undefined;
  const isFill = (argv: readonly string[]) =>
    argv.includes("backfill") || argv.includes("syncFullHistory");

  await t.step("M2-1: пусто — backfill на main, затем sync", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(count("0\n"));
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    const at = lines.indexOf(FILLING);
    assertEquals(lines.slice(at, at + 3), [FILLING, BACKFILL, SYNC]);
    assertEquals(docker.watches.filter(isFill).length, 2);
    const summary = docker.probes.findIndex((argv) => argv[1] === "ps");
    const probe = docker.probes.findIndex(isRatesProbe);
    assertEquals(summary < probe, true, "проба — после сводки");
    const web = lines.findIndex((line) =>
      line.includes("local-stack/docker-compose.yml")
    );
    assertEquals(at + 2 < web, true, "курсы — до web");
  });

  await t.step("M2-2: не пусто — строка пропуска, заполнения нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    assertEquals(lines.includes("курсы валют: 8178 строк — пропуск"), true);
    assertEquals([...docker.runs, ...docker.watches].filter(isFill), []);
    assertEquals(lines.includes(FILLING), false);
  });

  await t.step(
    "M2-3: dry, пусто — три строки, ничего не выполнено",
    async () => {
      const lines: string[] = [];
      const docker = new FakeDocker(count("0\n"));
      const result = await mpInit(true, lines, docker);
      assertEquals(result.exitCode, 0);
      const at = lines.indexOf(FILLING);
      assertEquals(lines.slice(at, at + 3), [FILLING, BACKFILL, SYNC]);
      assertEquals(docker.runs, []);
      assertEquals(docker.watches, []);
      assertEquals(docker.probes.some(isRatesProbe), true, "проба — и в dry");
    },
  );

  await t.step("M2-4: backfill упал — его rc, sync и web стоят", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (isRatesProbe(argv)) return { code: 0, stdout: "0\n", stderr: "" };
      if (argv.includes("backfill")) return { code: 1, stdout: "", stderr: "" };
      return undefined;
    });
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 1);
    assertEquals(result.web, false);
    assertEquals(
      lines.at(-1),
      "mpu mp-init: курсы валют — backfill упал (rc=1); web не поднимаю",
    );
    assertEquals(lines.includes(SYNC), false);
    assertEquals(
      lines.some((line) => line.includes("local-stack/docker-compose.yml")),
      false,
    );
  });

  await t.step("M2-5: пропущенные дни — одна строка на все", async () => {
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
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines.filter((line) => line.startsWith("warning: курсы")),
      [
        "warning: курсы валют — пропущены дни 2024-03-05, 2024-03-06: " +
        "догнать docker exec sl-0-cli node cli " +
        "service:currenciesRatesParser loadData --date-from D --date-to D",
      ],
    );
  });

  await t.step("backfill без ошибок — предупреждения нет", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(count("0\n")));
    assertEquals(
      lines.some((line) => line.startsWith("warning: курсы")),
      false,
    );
  });

  await t.step(
    "M2-6: проба не удалась — предупреждение, web идёт",
    async () => {
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
        assertEquals(result.exitCode, 0);
        assertEquals(
          lines.includes(
            "warning: курсы валют — проба не удалась, шаг пропущен",
          ),
          true,
        );
        assertEquals(docker.watches.filter(isFill), []);
        assertEquals(result.web, true);
      }
    },
  );

  await t.step("M2-7: sync — у инстанса sl-1, не у main", async () => {
    const docker = new FakeDocker(count("0\n"));
    await mpInit(false, [], docker);
    assertEquals(
      docker.watches.filter((argv) => argv.includes("syncFullHistory")).map((
        argv,
      ) => argv[2]),
      ["sl-1-cli"],
    );
    assertEquals(
      docker.watches.filter((argv) => argv.includes("backfill")).map((argv) =>
        argv[2]
      ),
      ["sl-0-cli"],
    );
  });

  await t.step("sync упал — его rc, web стоит", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) => {
      if (isRatesProbe(argv)) return { code: 0, stdout: "0\n", stderr: "" };
      if (argv.includes("syncFullHistory")) {
        return { code: 5, stdout: "", stderr: "" };
      }
      return undefined;
    });
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 5);
    assertEquals(
      lines.at(-1),
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

Deno.test("web поверх core: инфра SW из local-stack (M3)", async (t) => {
  await t.step("M3-1: инфра в сети — строк нет, проба была", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    await mpInit(true, lines, docker);
    assertEquals(lines.some((line) => line.includes("sw-infra")), false);
    assertEquals(lines.some((line) => line.includes("rm -f")), false);
    assertEquals(
      docker.probes.filter((argv) =>
        argv.includes("{{json .NetworkSettings.Networks}}")
      ).map((argv) => argv.at(-1)),
      ["mp-sw-pg", "redis-dev"],
    );
  });

  await t.step("M3-2: не в той сети — rm -f и compose инфры", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("{{json .NetworkSettings.Networks}}") &&
        argv.at(-1) === "mp-sw-pg"
        ? { code: 0, stdout: '{"mp-config-local_ws_default":{}}\n', stderr: "" }
        : undefined
    );
    await mpInit(true, lines, docker);
    const at = lines.indexOf("$ docker rm -f mp-sw-pg redis-dev");
    assertEquals(at >= 0, true, lines.join("\n"));
    assertEquals(lines[at + 1], INFRA_LINE);
  });

  await t.step("M3-3: контейнеров нет — только compose", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker(noInfra);
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    assertEquals(lines.some((line) => line.includes("rm -f")), false);
    assertEquals(lines.includes(INFRA_LINE), true, lines.join("\n"));
    assertEquals(docker.runs.some((argv) => argv[1] === "rm"), false);
  });

  await t.step("инфра упала — её rc, web стоит", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.some((arg) => arg.endsWith("compose.sw-infra.yaml"))
        ? { code: 4, stdout: "", stderr: "" }
        : noInfra(argv)
    );
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 4);
    assertEquals(result.web, false);
    assertEquals(
      lines.at(-1),
      "mpu mp-init: стек 'sw-infra' упал (rc=4); остальные не поднимаю",
    );
  });
});

Deno.test("web поверх core: вход в Nexus (M3)", async (t) => {
  await t.step("M3-4: вход есть — строк входа нет", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    await mpInit(false, lines, docker);
    assertEquals(lines.some((line) => line.includes("docker login")), false);
    assertEquals(lines.includes(webLine("sw-back sw-front sl-front")), true);
  });

  await t.step("M3-5: NPM_AUTH — логин, пароль только в stdin", async () => {
    for (const dryRun of [true, false]) {
      const lines: string[] = [];
      const docker = new FakeDocker();
      const result = await mpInit(dryRun, lines, docker, {
        files: WITH_NPM_AUTH,
      });
      assertEquals(
        lines.includes(
          "$ docker login nexus.btlz-api.ru -u robot --password-stdin",
        ),
        true,
        lines.join("\n"),
      );
      const everything = JSON.stringify([
        lines,
        result,
        docker.probes,
        docker.runs,
        docker.watches,
      ]);
      for (const secret of [PASSWORD, NPM_AUTH]) {
        assertEquals(everything.includes(secret), false, secret);
      }
      const login = docker.runs.findIndex((argv) => argv[1] === "login");
      if (dryRun) {
        assertEquals(login, -1);
        continue;
      }
      assertEquals(docker.inputs[login]?.stdin, PASSWORD);
    }
  });

  await t.step("M3-6: ни входа, ни NPM_AUTH — web без sw-back", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker, { files: NO_NEXUS });
    assertEquals(result.exitCode, 0);
    assertEquals(lines.includes(NO_ACCESS_WARNING), true, lines.join("\n"));
    assertEquals(lines.includes(webLine("sw-front sl-front")), true);
    assertEquals(
      lines.at(-1),
      "mp-init: поднят core (nats/sl-0/sl-1/nginx/dt-host) + " +
        "web (sw-front/sl-front)",
    );
  });

  await t.step("M3-13: вход упал — его rc, web стоит", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "login" ? { code: 5, stdout: "", stderr: "" } : undefined
    );
    const result = await mpInit(false, lines, docker, {
      files: WITH_NPM_AUTH,
    });
    assertEquals(result.exitCode, 5);
    assertEquals(result.web, false);
    assertEquals(
      lines.at(-1),
      "mpu mp-init: вход в nexus.btlz-api.ru упал (rc=5)",
    );
    assertEquals(
      docker.runs.some((argv) => argv.includes("--no-deps")),
      false,
    );
  });

  await t.step("M3-14: NPM_AUTH без `:` — как M3-6", async () => {
    for (const auth of [btoa("robot"), "не base64"]) {
      const lines: string[] = [];
      await mpInit(false, lines, new FakeDocker(), {
        files: { [DOCKER_CONFIG]: null, [DOT_ENV]: `NPM_AUTH=${auth}\n` },
      });
      assertEquals(lines.includes(NO_ACCESS_WARNING), true, auth);
      assertEquals(lines.includes(webLine("sw-front sl-front")), true, auth);
    }
  });

  await t.step("NPM_AUTH в кавычках — вход по нему", async () => {
    for (const quote of ['"', "'"]) {
      const lines: string[] = [];
      await mpInit(true, lines, new FakeDocker(), {
        files: {
          [DOCKER_CONFIG]: null,
          [DOT_ENV]: `export NPM_AUTH=${quote}${NPM_AUTH}${quote}\n`,
        },
      });
      assertEquals(
        lines.includes(
          "$ docker login nexus.btlz-api.ru -u robot --password-stdin",
        ),
        true,
        quote,
      );
    }
  });

  await t.step("битый config.json — входа нет", async () => {
    const lines: string[] = [];
    await mpInit(false, lines, new FakeDocker(), {
      files: { [DOCKER_CONFIG]: "{", [DOT_ENV]: null },
    });
    assertEquals(lines.includes(NO_ACCESS_WARNING), true);
  });
});

Deno.test("web поверх core: тег зависимостей и web (M3)", async (t) => {
  await t.step("M3-7: dry — строка web с окружением и --no-deps", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    await mpInit(true, lines, docker);
    assertEquals(lines.at(-2), webLine("sw-back sw-front sl-front"));
    assertEquals(
      docker.probes.some((argv) =>
        argv.join(" ") ===
          "docker manifest inspect " +
            `nexus.btlz-api.ru/base-images/sw-back-deps:${DEPS_TAG}`
      ),
      true,
    );
  });

  await t.step("M3-7: прогон — окружение уходит процессу", async () => {
    const docker = new FakeDocker();
    await mpInit(false, [], docker);
    const web = docker.runs.findIndex((argv) => argv.includes("--no-deps"));
    assertEquals(docker.runs[web].slice(0, 4), [
      "docker",
      "compose",
      "-f",
      `${LOCAL_STACK}/docker-compose.yml`,
    ]);
    assertEquals(docker.inputs[web]?.env, {
      SW_BACK_SRC: `${ROOT}/sw-back`,
      SW_FRONT_SRC: `${ROOT}/sw-front`,
      SL_FRONT_SRC: `${ROOT}/sl-front`,
      SW_BACK_DEPS_TAG: DEPS_TAG,
      SW_BACK_INTERNAL_API_URL: "http://internal-api:5100",
    });
  });

  await t.step("M3-8: образа зависимостей нет — web без sw-back", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv[1] === "manifest" ? { code: 1, stdout: "", stderr: "" } : undefined
    );
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines.includes(
        `warning: sw-back: нет образа зависимостей под этот lock (${DEPS_TAG})`,
      ),
      true,
      lines.join("\n"),
    );
    assertEquals(lines.includes(webLine("sw-front sl-front")), true);
  });

  await t.step("M3-9: SW_BACK_INTERNAL_API_URL из $L/.env", async () => {
    const lines: string[] = [];
    await mpInit(true, lines, new FakeDocker(), {
      files: {
        [DOT_ENV]: "SW_BACK_INTERNAL_API_URL=http://x:1 # флот\nOTHER=1\n",
      },
    });
    assertEquals(
      lines.includes(webLine("sw-back sw-front sl-front", "http://x:1")),
      true,
      lines.join("\n"),
    );
  });

  await t.step("M3-11: web упал — его rc", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker((argv) =>
      argv.includes("--no-deps")
        ? { code: 3, stdout: "", stderr: "" }
        : undefined
    );
    const result = await mpInit(false, lines, docker);
    assertEquals(result.exitCode, 3);
    assertEquals(result.web, false);
    assertEquals(lines.at(-1), "mpu mp-init: web упал (rc=3)");
  });

  await t.step("M3-15: нет файла для тега — web без sw-back", async () => {
    const lines: string[] = [];
    const docker = new FakeDocker();
    const result = await mpInit(false, lines, docker, {
      files: { [`${ROOT}/sw-back/.npmrc`]: null },
    });
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines.includes(
        `warning: sw-back: тег зависимостей не снят — нет ${ROOT}/sw-back/` +
          ".npmrc; sw-back не поднимаю",
      ),
      true,
      lines.join("\n"),
    );
    const web = lines.find((line) => line.includes("--no-deps")) ?? "";
    assertEquals(web.endsWith("--force-recreate sw-front sl-front"), true, web);
    assertEquals(docker.probes.some((argv) => argv[1] === "manifest"), false);
  });
});
