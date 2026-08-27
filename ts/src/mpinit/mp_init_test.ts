/**
 * Команда `mpu mp-init` (`docs/specs/mp-init.md`): последовательность
 * шагов, сухой прогон против эталона канала, probe'ы и fail-fast.
 *
 * Живого docker здесь нет: запуск подменён функцией, отвечающей по
 * argv. Это единственный способ проверить порядок шагов — а порядок и
 * есть контракт команды.
 *
 * Голден снят на машине оператора, и при обезличивании домашний
 * каталог стал кириллическим — такой путь shell-квотирование берёт в
 * кавычки, а в фикстуре кавычек нет. Поэтому сверка идёт после замены
 * домашнего каталога на ASCII: расхождение в фикстуре, а не в форме.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  configDirOf,
  localStackDirOf,
  type ProcessOutcome,
  type RunDocker,
  runMpInit,
} from "./cmd_mp_init.ts";
import { CONFLICTING, fullPlan, stepLine } from "./plan.ts";

const HOME = "/home/operator";
const CONFIG = `${HOME}/mr/mp/mp-config-local`;
const LOCAL_STACK = `${HOME}/mr/mp/local-stack`;
/** Домашний каталог фикстуры; при обезличивании он стал кириллическим. */
const GOLDEN_HOME = "/home/оператор";

const ok: ProcessOutcome = { code: 0, stdout: "" };

/** io с домашним каталогом и накоплением служебных строк. */
function ioWith(lines: string[], env: Record<string, string> = {}) {
  return makeFakeIo({
    env: (name: string) => ({ HOME, ...env })[name],
    progress: (line: string) => void lines.push(line),
  });
}

/** Всё существует, всё запущено, все probe'ы успешны. */
const allPresent: RunDocker = (argv) =>
  Promise.resolve(
    argv.includes("{{.State.Running}}") ? { code: 0, stdout: "true\n" } : ok,
  );

/** Существуют все пути, кроме опционального `.sl-dt.env` стенда. */
const existsExceptDtEnv = (path: string) => !path.endsWith(".sl-dt.env");

async function golden(): Promise<string> {
  const text = await Deno.readTextFile(
    new URL("./testdata/mp-init/dry-run.stdout", import.meta.url),
  );
  return text.replaceAll(GOLDEN_HOME, HOME);
}

Deno.test("сухой прогон печатает последовательность — эталон канала", async () => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const run: RunDocker = (argv) => {
    calls.push([...argv]);
    return Promise.resolve(ok);
  };
  const result = await runMpInit({ "dry-run": true }, ioWith(lines), {
    runDocker: run,
    exists: existsExceptDtEnv,
  });

  assertEquals(`${lines.join("\n")}\n`, await golden());
  assertEquals(result.exitCode, 0);
  // Ни одной мутации: в dry-run выполняются только probe'ы.
  const mutations = calls.filter((argv) =>
    argv.includes("up") || argv.includes("create") || argv.includes("stop")
  );
  assertEquals(mutations, []);
});

Deno.test("порядок шагов: web поднимается после core", async () => {
  const lines: string[] = [];
  await runMpInit({ "dry-run": true }, ioWith(lines), {
    runDocker: allPresent,
    exists: existsExceptDtEnv,
  });
  const names = lines.filter((line) => line.startsWith("$ ")).map((line) => {
    if (line.includes("compose.mp-nats")) return "nats";
    if (line.includes("compose.sl-main")) return "sl-0";
    if (line.includes("compose.sl-instance")) return "sl-1";
    if (line.includes("compose.mp-nginx")) return "nginx";
    if (line.includes("compose.sl-dt-host")) return "dt-host";
    if (line.includes("compose.sw-back")) return "sw-back-deps";
    if (line.startsWith("$ docker stop")) return "stop";
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
    "sw-back-deps",
    "stop",
    "web",
  ]);
});

Deno.test("образы: core останавливает, web только предупреждает", async (t) => {
  const missing = (image: string): RunDocker => (argv) =>
    Promise.resolve(
      argv[1] === "image" && argv[3] === image ? { code: 1, stdout: "" } : ok,
    );

  await t.step("нет core-образа — отказ, exit 1", async () => {
    const lines: string[] = [];
    await assertRejects(
      () =>
        runMpInit({ "dry-run": false }, ioWith(lines), {
          runDocker: missing("mp-pg:local"),
          exists: existsExceptDtEnv,
        }),
      DomainError,
      "нет обязательных образов: mp-pg:local → mp-pg-build-image",
    );
    // Ни один стек не поднимался: отказ до первого `up`.
    assertEquals(lines.some((line) => line.includes("up -d")), false);
  });

  await t.step(
    "нет web-образа — предупреждение, core поднимается",
    async () => {
      const lines: string[] = [];
      const result = await runMpInit({ "dry-run": false }, ioWith(lines), {
        runDocker: missing("sl-front-dev:local"),
        exists: existsExceptDtEnv,
      });
      assertEquals(result.exitCode, 0);
      assertEquals(
        lines.some((line) =>
          line === "warning: нет web-образов: sl-front-dev:local → " +
              "sl-front-build-dev-image"
        ),
        true,
        lines.join("\n"),
      );
      assertEquals(
        lines.some((line) => line.includes("compose.mp-nats")),
        true,
      );
    },
  );

  await t.step("в сухом прогоне нет core-образа — тоже warning", async () => {
    const lines: string[] = [];
    const result = await runMpInit({ "dry-run": true }, ioWith(lines), {
      runDocker: missing("mp-back:local"),
      exists: existsExceptDtEnv,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(
      lines[0].startsWith("warning: нет обязательных образов"),
      true,
    );
    // Смысл сухого прогона — показать всю последовательность целиком.
    assertEquals(
      lines.some((line) => line.includes("docker-compose.yml")),
      true,
    );
  });
});

Deno.test("сеть и том создаются только при отсутствии", async (t) => {
  const missingProbe = (what: string): RunDocker => (argv) =>
    Promise.resolve(
      argv[1] === what && argv[2] === "inspect" ? { code: 1, stdout: "" } : ok,
    );

  await t.step("есть — команда создания не печатается", async () => {
    const lines: string[] = [];
    await runMpInit({ "dry-run": false }, ioWith(lines), {
      runDocker: allPresent,
      exists: existsExceptDtEnv,
    });
    assertEquals(lines.some((line) => line.includes("network create")), false);
    assertEquals(lines.some((line) => line.includes("volume create")), false);
  });

  await t.step("нет сети — создаётся с подсетью спеки", async () => {
    const lines: string[] = [];
    await runMpInit({ "dry-run": false }, ioWith(lines), {
      runDocker: missingProbe("network"),
      exists: existsExceptDtEnv,
    });
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
    await runMpInit({ "dry-run": false }, ioWith(lines), {
      runDocker: missingProbe("volume"),
      exists: existsExceptDtEnv,
    });
    assertEquals(lines[0], "$ docker volume create mp-back-node-modules");
  });
});

Deno.test("стоп конфликтующих: в прогоне только запущенные", async (t) => {
  await t.step("запущен один из трёх — гасится он один", async () => {
    const lines: string[] = [];
    const run: RunDocker = (argv) =>
      Promise.resolve(
        argv.includes("{{.State.Running}}")
          ? {
            code: 0,
            stdout: argv[argv.length - 1] === "nextjs-dev"
              ? "true\n"
              : "false\n",
          }
          : ok,
      );
    await runMpInit({ "dry-run": false }, ioWith(lines), {
      runDocker: run,
      exists: existsExceptDtEnv,
    });
    assertEquals(
      lines.filter((line) => line.startsWith("$ docker stop")),
      ["$ docker stop nextjs-dev  # только запущенные"],
    );
  });

  await t.step("не запущен никто — шага нет вовсе", async () => {
    const lines: string[] = [];
    const run: RunDocker = (argv) =>
      Promise.resolve(
        argv.includes("{{.State.Running}}")
          ? { code: 0, stdout: "false\n" }
          : ok,
      );
    await runMpInit({ "dry-run": false }, ioWith(lines), {
      runDocker: run,
      exists: existsExceptDtEnv,
    });
    assertEquals(lines.some((line) => line.startsWith("$ docker stop")), false);
  });

  await t.step("в сухом прогоне печатается весь список", async () => {
    const lines: string[] = [];
    await runMpInit({ "dry-run": true }, ioWith(lines), {
      runDocker: allPresent,
      exists: existsExceptDtEnv,
    });
    assertEquals(
      lines.filter((line) => line.startsWith("$ docker stop")),
      [`$ docker stop ${CONFLICTING.join(" ")}  # только запущенные`],
    );
  });
});

Deno.test("упавший стек: fail-fast и код docker наружу", async () => {
  const lines: string[] = [];
  const run: RunDocker = (argv) =>
    Promise.resolve(
      argv.includes("up") && argv.some((a) => a.includes("compose.sl-main"))
        ? { code: 17, stdout: "" }
        : ok,
    );
  const result = await runMpInit({ "dry-run": false }, ioWith(lines), {
    runDocker: run,
    exists: existsExceptDtEnv,
  });
  assertEquals(result.exitCode, 17);
  assertEquals(
    lines.some((line) =>
      line === "mpu mp-init: стек 'sl-0' упал (rc=17); остальные не поднимаю"
    ),
    true,
    lines.join("\n"),
  );
  // Следующие стеки не поднимались.
  assertEquals(
    lines.some((line) => line.includes("compose.sl-instance")),
    false,
  );
});

Deno.test("web-часть: нет каталога — пропуск, а не ошибка", async () => {
  const lines: string[] = [];
  const result = await runMpInit({ "dry-run": false }, ioWith(lines), {
    runDocker: allPresent,
    exists: (path) => !path.includes("local-stack"),
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.web, false);
  // Строка про пропуск печатается на своём шаге — после core, а не в
  // начале: «пропущено» до единой поднятой строки читалось бы как
  // «ничего не делаю».
  assertEquals(
    lines[lines.length - 2],
    `каталог local-stack не найден: ${LOCAL_STACK}; web-стек пропущен`,
  );
  assertEquals(lines[0].includes("compose.mp-nats"), true, lines[0]);
  assertEquals(
    lines.some((line) => line.includes("docker-compose.yml")),
    false,
  );
  // БД-зависимости sw-back тоже не поднимаются: их шаг — часть web.
  assertEquals(lines.some((line) => line.includes("compose.sw-back")), false);
  assertEquals(
    lines[lines.length - 1],
    "mp-init: core поднят — nats, sl-0, sl-1, nginx, dt-host",
  );
});

Deno.test("каталог стенда: env старше HOME, отсутствие — exit 2", async (t) => {
  await t.step("MPU_MP_CONFIG_LOCAL побеждает", () => {
    const io = ioWith([], { MPU_MP_CONFIG_LOCAL: "/opt/стенд" });
    assertEquals(configDirOf(io), "/opt/стенд");
    assertEquals(localStackDirOf("/opt/стенд"), "/opt/local-stack");
  });

  await t.step("без переменной — путь от HOME", () => {
    assertEquals(configDirOf(ioWith([])), CONFIG);
  });

  await t.step("каталога нет — ошибка ввода с подсказкой", async () => {
    await assertRejects(
      () =>
        runMpInit({ "dry-run": true }, ioWith([]), {
          runDocker: allPresent,
          exists: () => false,
        }),
      UsageError,
      `каталог mp-config-local не найден: ${CONFIG}`,
    );
  });
});

Deno.test("опциональные env-файлы включаются только существующие", () => {
  const withAll = fullPlan({
    configDir: CONFIG,
    localStackDir: LOCAL_STACK,
    exists: () => true,
    conflicting: [],
  }).map(stepLine).join("\n");
  const withoutDt = fullPlan({
    configDir: CONFIG,
    localStackDir: LOCAL_STACK,
    exists: existsExceptDtEnv,
    conflicting: [],
  }).map(stepLine).join("\n");
  // Несуществующий env-файл в argv — отказ compose'а целиком.
  assertEquals(withAll.includes("/.sl-dt.env"), true);
  assertEquals(withoutDt.includes("/.sl-dt.env"), false);
  // А базовые файлы передаются всегда, даже когда их нет на диске:
  // спека относит к опциональным только `.env` и `.sl-*.env` без
  // `base`. Пропустив базовый, мы подняли бы стек на неполном наборе
  // переменных — молча и «не тем».
  const nothingExists = fullPlan({
    configDir: CONFIG,
    localStackDir: LOCAL_STACK,
    exists: () => false,
    conflicting: [],
  }).map(stepLine).join("\n");
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
  const run: RunDocker = (argv) => {
    if (argv[1] === "network" && argv[2] === "inspect") {
      return Promise.resolve({ code: 1, stdout: "" });
    }
    if (argv[1] === "network" && argv[2] === "create") {
      // 125 — обычный код конфликта подсети у docker.
      return Promise.resolve({ code: 125, stdout: "" });
    }
    return Promise.resolve(ok);
  };
  const result = await runMpInit({ "dry-run": false }, ioWith(lines), {
    runDocker: run,
    exists: existsExceptDtEnv,
  });
  // Код docker'а идёт наружу как есть: скрипт-обёртка отличает его от
  // «нет образов» (1) только по числу.
  assertEquals(result.exitCode, 125);
  assertEquals(lines.some((line) => line.includes("up -d")), false);
  assertEquals(result.steps, [
    "$ docker network create --driver=bridge " +
    "mp-shared-net --subnet=178.20.0.0/16",
  ]);
});
