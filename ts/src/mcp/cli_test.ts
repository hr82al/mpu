/**
 * Поверхность `mpu mcp` и токен доступа: контракт из раздела
 * «CLI-контракт» спеки — коды завершения, права файла токена и то, что
 * токен не печатается нигде, кроме `mpu mcp token`.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { setConfigValue } from "../config/mod.ts";
import { makeDenoIo } from "../runtime/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { CommandIo } from "../command/mod.ts";
import { commands } from "../registry/mod.ts";
import { NO_INVOKE_LOG } from "../invokelog/mod.ts";
import { runMcpServer } from "./cli.ts";
import { LOOPBACK, type RunningServer, serveMcp } from "./server.ts";
import { ensureAccessToken } from "./token.ts";
import { VERSION } from "../version.ts";
import {
  type RunProgram,
  SERVICE_NAME,
  type ServiceDeps,
  serviceDepsIfAny,
  unitText,
} from "./service.ts";

/** Буфер вывода: коды завершения проверяются вместе с текстом. */
function makeOutput() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    sink: {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

/** Временный конфиг-каталог с настоящим io поверх файловой системы. */
async function withStore(
  fn: (io: CommandIo, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    // Конфиг-каталог временный целиком: и токен, и кэш-БД с
    // предпочтениями, — в базу пользователя тест не пишет.
    const real = makeDenoIo(dir);
    // Службу пользователя тесты не видят: HOME — внутри временного
    // каталога, XDG_CONFIG_HOME не задана, и описания службы там нет.
    // Иначе голое `mpu mcp` на порту из конфига читало бы настоящий каталог
    // служб и у запускающего с установленной службой шло бы к настоящему
    // `systemctl` — перезапуская её при широких правах.
    const io: CommandIo = {
      ...real,
      env: (name) =>
        name === "HOME"
          ? `${dir}/home`
          : name === "XDG_CONFIG_HOME"
          ? undefined
          : real.env(name),
    };
    // Предохранитель: тест, получивший io с настоящим окружением, краснеет
    // здесь, до всякого обращения к службе.
    const units = serviceDepsIfAny(io)?.dir;
    assert(
      units !== undefined && units.startsWith(`${dir}/`),
      `каталог служб теста вне временного каталога: ${units}`,
    );
    await fn(io, dir);
    // Тесты на порту из конфига с настоящим `spawnProgram` герметичны
    // только отсутствием описания: `describedProgram` отвечает «нет», не
    // дойдя до менеджера. Проверка — после теста: каталог создан только
    // что, и до `fn` описанию взяться неоткуда; положил его сам тест —
    // краснеет здесь.
    const described = await Deno.lstat(`${units}/${SERVICE_NAME}`).then(
      () => true,
      (err: unknown) => {
        if (err instanceof Deno.errors.NotFound) return false;
        throw err;
      },
    );
    assertEquals(
      described,
      false,
      `во временном каталоге служб лежит описание: ${units}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("токен создаётся при первой надобности и переиспользуется", async () => {
  await withStore(async (io, dir) => {
    const first = await ensureAccessToken(io);
    assertMatch(first, /^[A-Za-z0-9_-]{20,}$/);
    assertEquals(await ensureAccessToken(io), first);
    assertStringIncludes(await Deno.readTextFile(`${dir}/token`), first);
  });
});

Deno.test("файл токена создаётся с правами 0600", async () => {
  await withStore(async (io, dir) => {
    await ensureAccessToken(io);
    const mode = (await Deno.stat(`${dir}/token`)).mode;
    // Права — не украшение: файл даёт исполнение мутирующих команд.
    assertEquals(mode === null ? null : mode & 0o777, 0o600);
  });
});

Deno.test("mpu mcp token печатает заголовки одной строкой", async () => {
  await withStore(async (io, dir) => {
    const output = makeOutput();
    assertEquals(await runCli(["mcp", "token"], io, output.sink), 0);
    const token = (await Deno.readTextFile(`${dir}/token`)).trim();
    assertEquals(
      output.stdout(),
      `{"Authorization":"Bearer ${token}"}\n`,
    );
    assertEquals(output.stderr(), "");
  });
});

Deno.test("токен не печатается прочими поверхностями", async (t) => {
  await withStore(async (io, dir) => {
    const token = await ensureAccessToken(io);
    const surfaces: readonly (readonly string[])[] = [
      [],
      ["--help"],
      ["mcp", "--help"],
      ["mcp", "token", "--help"],
      ["xlsx", "alias", "ls"],
      ["xlsx", "resolve"],
    ];
    for (const argv of surfaces) {
      await t.step(`mpu ${argv.join(" ")}`, async () => {
        const output = makeOutput();
        await runCli(argv, io, output.sink);
        assertEquals(output.stdout().includes(token), false, "токен в stdout");
        assertEquals(output.stderr().includes(token), false, "токен в stderr");
      });
    }
    // Сам файл при этом на месте: проверяли поверхности, а не удаление.
    assertStringIncludes(await Deno.readTextFile(`${dir}/token`), token);
  });
});

Deno.test("значение --profile вне ro/rw — exit 2", async (t) => {
  for (const value of ["all", "ro,wr", ""]) {
    await t.step(`--profile ${value || "(пусто)"}`, async () => {
      const output = makeOutput();
      const code = await runMcpServer(["--profile", value], {
        io: makeFakeIo(),
        output: output.sink,
        commands,
        log: NO_INVOKE_LOG,
      });
      assertEquals(code, 2);
      assertStringIncludes(output.stderr(), "--profile");
    });
  }
});

Deno.test("неизвестный флаг запуска — exit 2", async () => {
  const output = makeOutput();
  const code = await runMcpServer(["--host", "0.0.0.0"], {
    io: makeFakeIo(),
    output: output.sink,
    commands,
    log: NO_INVOKE_LOG,
  });
  assertEquals(code, 2);
  assertStringIncludes(output.stderr(), "--host");
});

Deno.test("занятый порт — exit 1 и текст спеки", async () => {
  const busy = await serveMcp({
    port: 0,
    profiles: ["ro"],
    token: "zanyato",
    deps: { io: makeFakeIo(), commands, version: VERSION, log: NO_INVOKE_LOG },
  });
  try {
    await withStore(async (io) => {
      const output = makeOutput();
      const code = await runMcpServer(["--port", String(busy.port)], {
        io,
        output: output.sink,
        commands,
        log: NO_INVOKE_LOG,
      });
      assertEquals(code, 1);
      assertEquals(output.stderr(), `mpu mcp: порт ${busy.port} занят\n`);
    });
  } finally {
    await busy.shutdown();
  }
});

Deno.test("голый «mpu mcp» уходит в поверхность запуска", async (t) => {
  await t.step("флаги разбирает она, а не индекс уровня", async () => {
    const output = makeOutput();
    // Ошибка ввода возвращается из самой поверхности: если бы вызов
    // остался индексом группы, был бы напечатан список подкоманд.
    assertEquals(
      await runCli(["mcp", "--profile", "all"], makeFakeIo(), output.sink),
      2,
    );
    assertStringIncludes(output.stderr(), "mpu mcp: значение --profile");
    assertEquals(output.stdout(), "");
  });

  await t.step("--help остаётся индексом уровня", async () => {
    const output = makeOutput();
    assertEquals(
      await runCli(["mcp", "--help"], makeFakeIo(), output.sink),
      0,
    );
    assertStringIncludes(output.stdout(), "token");
    assertEquals(output.stderr(), "");
  });

  await t.step("имя подкоманды по-прежнему маршрутизируется", async () => {
    const output = makeOutput();
    assertEquals(
      await runCli(["mcp", "wat"], makeFakeIo(), output.sink),
      2,
    );
    assertStringIncludes(output.stderr(), "No such command 'mcp wat'");
  });
});

Deno.test("значение --port не порт — exit 2", async (t) => {
  for (const value of ["восемь", "-1", "70000"]) {
    await t.step(`--port ${value}`, async () => {
      const output = makeOutput();
      const code = await runMcpServer([`--port=${value}`], {
        io: makeFakeIo(),
        output: output.sink,
        commands,
        log: NO_INVOKE_LOG,
      });
      assertEquals(code, 2);
      assertStringIncludes(output.stderr(), "--port");
    });
  }
});

Deno.test("голое mpu mcp без HOME: служба считается отсутствующей, порт не уступается", async (t) => {
  // Отказ без HOME держат тесты службы и подкоманд; здесь — что голое
  // `mpu mcp` при этом не уступает порт и поднимает сервер. Неудавшийся
  // опрос менеджера тоже означает «уступки нет», поэтому реализацию,
  // взявшую каталог служб без HOME, этот тест не отличит.
  const envs: ReadonlyArray<
    readonly [
      string,
      (dir: string) => Readonly<Record<string, string | undefined>>,
    ]
  > = [
    ["HOME не задана", () => ({ HOME: undefined, XDG_CONFIG_HOME: undefined })],
    ["HOME пуста", () => ({ HOME: "", XDG_CONFIG_HOME: undefined })],
    ["HOME не задана, XDG_CONFIG_HOME абсолютна", (dir) => ({
      HOME: undefined,
      XDG_CONFIG_HOME: `${dir}/xdg`,
    })],
  ];
  for (const [name, envFor] of envs) {
    await t.step(name, async () => {
      await withStore(async (real, dir) => {
        usePort(real, await freePort());
        const overrides = envFor(dir);
        // Зависимостей службы не внедряем: внедрённые, они обошли бы
        // проверку HOME (`mcp-service.md`, «Граничные случаи и ошибки»).
        const io: CommandIo = {
          ...real,
          env: (key) => key in overrides ? overrides[key] : real.env(key),
        };
        const output = makeOutput();
        const stop = new AbortController();
        const listening = Promise.withResolvers<RunningServer>();
        const running = runMcpServer([], {
          io,
          output: output.sink,
          commands,
          log: NO_INVOKE_LOG,
          signal: stop.signal,
          onListen: listening.resolve,
        });
        // Наперегонки с завершением: запуск, отказавший до прослушивания,
        // даёт красный тест, а не вечное ожидание.
        const first = await Promise.race([
          listening.promise.then(() => "слушает"),
          running.then((code) => `завершился с ${code}`),
        ]);
        stop.abort();
        assertEquals(first, "слушает", output.stderr());
        assertEquals(await running, 0);
        assertEquals(
          output.stderr().includes("уступлен"),
          false,
          `порт уступлен без HOME:\n${output.stderr()}`,
        );
      });
    });
  }
});

Deno.test("порт берётся из конфига, когда флага нет", async () => {
  await withStore(async (io) => {
    // Свободный порт занимаем и сразу отпускаем: так он заведомо
    // существует и почти наверняка свободен к моменту запуска.
    const probe = await serveMcp({
      port: 0,
      profiles: ["ro"],
      token: "proba",
      deps: {
        io: makeFakeIo(),
        commands,
        log: NO_INVOKE_LOG,
        version: VERSION,
      },
    });
    const wanted = probe.port;
    await probe.shutdown();
    {
      using db = io.openCacheDb();
      setConfigValue(db, "mcp.port", String(wanted));
    }

    const stop = new AbortController();
    const listening = Promise.withResolvers<RunningServer>();
    const running = runMcpServer([], {
      io,
      output: makeOutput().sink,
      commands,
      log: NO_INVOKE_LOG,
      signal: stop.signal,
      onListen: listening.resolve,
    });
    const server = await listening.promise;
    assertEquals(server.port, wanted);
    stop.abort();
    await running;
  });
});

Deno.test("--profile поднимает только названные пути", async () => {
  await withStore(async (io) => {
    const stop = new AbortController();
    const listening = Promise.withResolvers<RunningServer>();
    const running = runMcpServer(["--profile", "ro", "--port", "0"], {
      io,
      output: makeOutput().sink,
      commands,
      log: NO_INVOKE_LOG,
      signal: stop.signal,
      onListen: listening.resolve,
    });
    const server = await listening.promise;
    const token = await ensureAccessToken(io);
    const response = await fetch(`http://${LOOPBACK}:${server.port}/rw`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assertEquals(response.status, 404);
    assertEquals(await response.text(), "");
    stop.abort();
    await running;
  });
});

Deno.test("mpu mcp поднимает сервер на петле и гаснет по сигналу", async () => {
  await withStore(async (io) => {
    const output = makeOutput();
    const stop = new AbortController();
    // Готовность сообщает сам сервер: опрос буфера здесь голодал бы
    // очередь микрозадач и не давал event loop продвинуться.
    const listening = Promise.withResolvers<RunningServer>();
    const running = runMcpServer(["--port", "0"], {
      io,
      output: output.sink,
      commands,
      log: NO_INVOKE_LOG,
      signal: stop.signal,
      onListen: listening.resolve,
    });
    const server = await listening.promise;
    assertEquals(server.hostname, LOOPBACK);
    assertStringIncludes(output.stderr(), `http://${LOOPBACK}:${server.port}`);
    stop.abort();
    assertEquals(await running, 0);
  });
});

Deno.test("голый вызов поднимает ro и rw на порту по умолчанию", async () => {
  await withStore(async (io) => {
    const originalServe = Deno.serve;
    let capturedPort: number | undefined;
    // DEFAULT_PORT в тесте не занимаем: на машине разработчика он может
    // быть занят настоящим `mpu mcp`. Перехватываем значение, с которым
    // код просит поднять сокет, а сам бинд подменяем на свободный порт —
    // на факт подъёма сервера и состав профилей подмена не влияет.
    Deno.serve = ((
      options: Deno.ServeTcpOptions,
      handler: Deno.ServeHandler,
    ) => {
      capturedPort = options.port;
      return originalServe({ ...options, port: 0 }, handler);
    }) as typeof Deno.serve;
    try {
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer([], {
        io,
        output: makeOutput().sink,
        commands,
        log: NO_INVOKE_LOG,
        signal: stop.signal,
        onListen: listening.resolve,
      });
      const server = await listening.promise;
      // Литерал, а не импортированный DEFAULT_PORT: сверка со своим же
      // источником не заметила бы, если умолчание сломают в server.ts.
      assertEquals(capturedPort, 7337);

      const token = await ensureAccessToken(io);
      for (const profile of ["ro", "rw"] as const) {
        const response = await fetch(
          `http://${LOOPBACK}:${server.port}/${profile}`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": "tools/list",
            },
            body: JSON.stringify(
              { jsonrpc: "2.0", id: 1, method: "tools/list" },
            ),
          },
        );
        assertEquals(response.status, 200, `профиль /${profile} не поднят`);
        await response.body?.cancel();
      }
      stop.abort();
      assertEquals(await running, 0);
    } finally {
      Deno.serve = originalServe;
    }
  });
});

Deno.test("у вызова тула нет stdin — понятная ошибка ввода, не зависание", async () => {
  // Долгоживущий процесс делит один stdin на все вызовы: команда,
  // читающая его (`mpu sql-ro` без аргумента SQL), забрала бы поток
  // сервера и повисла бы на нём.
  const env: Readonly<Record<string, string>> = {
    pg_1: "10.0.0.1",
    PG_MY_USER_NAME: "u",
    PG_MY_USER_PASSWORD: "p",
  };
  await withStore(async (base) => {
    const io: CommandIo = {
      ...base,
      envFile: {
        get: (name) => env[name],
        values: () => ({ ...env }),
        require: (name) => env[name] ?? "",
        set: () => Promise.reject(new Error("запись не ожидается")),
      },
    };
    const stop = new AbortController();
    const listening = Promise.withResolvers<RunningServer>();
    const running = runMcpServer(["--port", "0"], {
      io,
      output: makeOutput().sink,
      commands,
      log: NO_INVOKE_LOG,
      signal: stop.signal,
      onListen: listening.resolve,
    });
    try {
      const server = await listening.promise;
      const response = await fetch(`http://${LOOPBACK}:${server.port}/ro`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${await ensureAccessToken(io)}`,
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "sql_ro",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          // Аргумента SQL нет — команда пошла бы читать stdin.
          params: {
            name: "sql_ro",
            arguments: { selector: "sl-1", dry: true },
          },
        }),
      });
      assertStringIncludes(
        await response.text(),
        "stdin у вызова тула нет — передай значение аргументом",
      );
    } finally {
      stop.abort();
      await running;
    }
  });
});

/** Номер главного процесса подставной службы: им проверяется распознавание. */
const SERVICE_PID = 4242;

/** Порт, который заведомо существует и почти наверняка свободен. */
async function freePort(): Promise<number> {
  const probe = await serveMcp({
    port: 0,
    profiles: ["ro"],
    token: "proba",
    deps: { io: makeFakeIo(), commands, log: NO_INVOKE_LOG, version: VERSION },
  });
  const port = probe.port;
  await probe.shutdown();
  return port;
}

/**
 * Менеджер служб, помнящий, работает ли служба. Модель настоящая:
 * `stop` гасит, `start` поднимает, `is-active` отвечает состоянием.
 */
function fakeManager(
  active: { now: boolean },
  quirks: Quirks = {},
  /** Наблюдатель окна уступки: зовётся на каждом глаголе менеджера. */
  watch: (verb: string) => void = () => {},
) {
  const calls: string[] = [];
  const run: RunProgram = (_bin, args) => {
    const verb = args[1] ?? "";
    const asked = verb === "is-active" && calls.includes("is-active");
    const nth = calls.filter((called) => called === verb).length + 1;
    const afterStop = calls.includes("stop");
    calls.push(verb);
    watch(verb);
    if (quirks.vanishing && asked) active.now = false;
    if (
      verb === "is-active" && quirks.recheckRefusal && asked && !afterStop
    ) {
      return Promise.reject(
        new Deno.errors.NotCapable('Requires run access to "systemctl"'),
      );
    }
    if (
      verb === "is-active" && quirks.recheckCrash && asked && !afterStop
    ) {
      return Promise.reject(new TypeError("дефект своего кода"));
    }
    if (verb === "stop" && quirks.stopRefusal) {
      return Promise.reject(
        new Deno.errors.NotCapable('Requires run access to "systemctl"'),
      );
    }
    if (verb === "stop" && quirks.crashStop) {
      return Promise.reject(new TypeError("дефект своего кода"));
    }
    if (verb === "stop" && quirks.brokenStop) {
      active.now = false;
      return Promise.resolve({ code: 1, stdout: "", stderr: "Job failed\n" });
    }
    if (verb === "start" && quirks.startRefusal !== undefined) {
      return Promise.reject(
        quirks.startRefusal === "PermissionDenied"
          ? new Deno.errors.PermissionDenied("Permission denied (os error 13)")
          : new Deno.errors.NotCapable('Requires run access to "systemctl"'),
      );
    }
    if (verb === "start" && quirks.crashStart) {
      return Promise.reject(new TypeError("дефект своего кода"));
    }
    if (verb === "start" && quirks.brokenStart) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "порт занят\n" });
    }
    if (verb === "stop") active.now = false;
    if (verb === "stop" && quirks.stopGate !== undefined) {
      return quirks.stopGate.then(() => ({ code: 0, stdout: "", stderr: "" }));
    }
    if (verb === "start" || verb === "restart") active.now = true;
    const answer = verb === "is-active"
      ? (active.now ? "active" : "inactive")
      : verb === "is-enabled"
      ? "enabled"
      // Главный процесс службы: ноль, когда её нет, — как у настоящего
      // менеджера.
      : verb === "show"
      // Главный процесс службы. `self` — «служба это мы»: юнит
      // запускает тот же голый `mpu mcp`, и распознавание сравнивает
      // ответ менеджера с собственным номером процесса.
      ? String(quirks.self === true ? Deno.pid : SERVICE_PID)
      : "";
    const reply = { code: 0, stdout: `${answer}\n`, stderr: "" };
    const gated = quirks.pollGate;
    if (gated?.verb === verb && gated.nth === nth && !afterStop) {
      return gated.gate.then(() => reply);
    }
    return Promise.resolve(reply);
  };
  return { run, calls };
}

/**
 * Каталог служб в заданном состоянии. Описание и работа разведены: у
 * спеки это два разных случая — «службы нет» и «она остановлена», — и
 * оба обязаны оставлять машину нетронутой.
 */
/** Чем менеджер отличается от послушного: по одной причине на поле. */
interface Quirks {
  /** `start` отказывает: служба не поднимается обратно. */
  readonly brokenStart?: boolean;
  /** Служба гаснет сама сразу после первого вопроса о состоянии. */
  readonly vanishing?: boolean;
  /** `start` ломается дефектом кода, а не отказом менеджера. */
  readonly crashStart?: boolean;
  /** Главный процесс службы — этот процесс: запуск и есть служба. */
  readonly self?: boolean;
  /** Повторный вопрос о состоянии перед `stop` отказывает в праве. */
  readonly recheckRefusal?: boolean;
  /** Повторный вопрос о состоянии перед `stop` ломается дефектом кода. */
  readonly recheckCrash?: boolean;
  /** Вопрос опроса (глагол и его номер) отвечает, лишь когда тест отпустит. */
  readonly pollGate?: {
    readonly verb: "is-active" | "show";
    readonly nth: number;
    readonly gate: Promise<void>;
  };
  /** `stop` не запускается вовсе: прав на запуск нет. */
  readonly stopRefusal?: boolean;
  /** `stop` гасит службу, но отвечает ненулевым кодом. */
  readonly brokenStop?: boolean;
  /** `stop` ломается дефектом кода, а не отказом менеджера. */
  readonly crashStop?: boolean;
  /** `stop` отвечает, лишь когда тест отпустит: окно остановки открыто. */
  readonly stopGate?: Promise<void>;
  /** `start` не запускается вовсе: отказ в праве или прав на запуск нет. */
  readonly startRefusal?: "PermissionDenied" | "NotCapable";
}

async function withService(
  state: Quirks & {
    readonly described: boolean;
    readonly running?: boolean;
    /** Наблюдатель окна: видит порядок изнутри вызова. */
    readonly watch?: (verb: string) => void;
  },
  body: (
    deps: ServiceDeps,
    active: { now: boolean },
    calls: string[],
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/systemd/user`;
    await Deno.mkdir(dir, { recursive: true });
    if (state.described) {
      await Deno.writeTextFile(`${dir}/${SERVICE_NAME}`, unitText("/h/mpu"));
    }
    const active = { now: state.running ?? state.described };
    const manager = fakeManager(active, state, state.watch);
    await body(
      { dir, program: "/h/mpu", run: manager.run },
      active,
      manager.calls,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("голое mpu mcp уступает порт работающей службе и возвращает её", async () => {
  await withStore(async (io) => {
    const wanted = await freePort();
    {
      using db = io.openCacheDb();
      setConfigValue(db, "mcp.port", String(wanted));
    }
    await withService({ described: true }, async (deps, active, calls) => {
      const output = makeOutput();
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer([], {
        io,
        output: output.sink,
        commands,
        log: NO_INVOKE_LOG,
        signal: stop.signal,
        onListen: listening.resolve,
        service: { deps },
      });
      const server = await listening.promise;
      // Порт достался переднему плану — тот самый, что был у службы.
      assertEquals(server.port, wanted);
      assertEquals(active.now, false, "служба осталась работать");
      stop.abort();
      assertEquals(await running, 0);
      assertEquals(active.now, true, "служба не вернулась");
      assertEquals(calls.includes("stop"), true, calls.join(", "));
      assertEquals(calls.includes("start"), true, calls.join(", "));
      // Обе строки печатаются: с машиной владельца делается заметное.
      assertStringIncludes(output.stderr(), "остановлена, порт");
      assertStringIncludes(output.stderr(), "запущена снова");
    });
  });
});

Deno.test("службы не было — после голого mpu mcp её нет", async () => {
  await withStore(async (io) => {
    const wanted = await freePort();
    {
      using db = io.openCacheDb();
      setConfigValue(db, "mcp.port", String(wanted));
    }
    await withService({ described: false }, async (deps, active, calls) => {
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer([], {
        io,
        output: makeOutput().sink,
        commands,
        log: NO_INVOKE_LOG,
        signal: stop.signal,
        onListen: listening.resolve,
        service: { deps },
      });
      await listening.promise;
      stop.abort();
      assertEquals(await running, 0);
      assertEquals(active.now, false, "служба появилась там, где её не было");
      assertEquals(calls, [], `менеджеру что-то сказали: ${calls.join(", ")}`);
    });
  });
});

Deno.test("голый запуск на другом порту службу не трогает", async () => {
  await withStore(async (io) => {
    const theirs = await freePort();
    {
      using db = io.openCacheDb();
      // Служба стоит на своём порту, передний план просят на другом:
      // уступать нечего, занят он не ею.
      setConfigValue(db, "mcp.port", String(theirs));
    }
    await withService({ described: true }, async (deps, active, calls) => {
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer(["--port", "0"], {
        io,
        output: makeOutput().sink,
        commands,
        log: NO_INVOKE_LOG,
        signal: stop.signal,
        onListen: listening.resolve,
        service: { deps },
      });
      await listening.promise;
      stop.abort();
      assertEquals(await running, 0);
      assertEquals(active.now, true, "работающую службу тронули");
      assertEquals(calls, [], `менеджеру что-то сказали: ${calls.join(", ")}`);
    });
  });
});

Deno.test("прерывание возвращает службу", async () => {
  await withStore(async (io) => {
    const wanted = await freePort();
    {
      using db = io.openCacheDb();
      setConfigValue(db, "mcp.port", String(wanted));
    }
    await withService({ described: true }, async (deps, active) => {
      const listening = Promise.withResolvers<RunningServer>();
      // Подписка на сигнал — швом: настоящий сигнал пришлось бы слать
      // собственному прогону тестов.
      let interrupt: (() => void) | undefined;
      let unsubscribed = false;
      const running = runMcpServer([], {
        io,
        output: makeOutput().sink,
        commands,
        log: NO_INVOKE_LOG,
        onListen: listening.resolve,
        service: { deps },
        onInterrupt: (handle) => {
          interrupt = handle;
          return () => void (unsubscribed = true);
        },
      });
      await listening.promise;
      assertEquals(active.now, false);
      assert(interrupt !== undefined, "на прерывание никто не подписался");
      interrupt();
      assertEquals(await running, 0);
      assertEquals(active.now, true, "прерывание не вернуло службу");
      // Подписка снимается: иначе обработчик пережил бы сам вызов.
      assertEquals(unsubscribed, true, "подписка на сигнал не снята");
    });
  });
});

/**
 * Голый запуск со службой, у которого исход до прослушивания снимается
 * гонкой: отказавший запуск даёт красный тест с причиной, а не вечное
 * ожидание. Гасит сам и отдаёт итог; отказ запуска — строкой, а не
 * отклонением, чтобы тест сверял его наравне с кодом.
 */
async function listenOrFail(
  io: CommandIo,
  deps: ServiceDeps,
  whileListening: () => Promise<void> = () => Promise.resolve(),
): Promise<{ first: string; outcome: string; stderr: string }> {
  const output = makeOutput();
  const stop = new AbortController();
  const listening = Promise.withResolvers<RunningServer>();
  const running = runMcpServer([], {
    io,
    output: output.sink,
    commands,
    log: NO_INVOKE_LOG,
    signal: stop.signal,
    onListen: listening.resolve,
    service: { deps },
    // Подписка — швом: настоящие обработчики пережили бы тест.
    onInterrupt: () => () => {},
  });
  const settled = running.then(
    (code) => `код ${code}`,
    (err: unknown) => `отказал: ${String(err)}`,
  );
  const first = await Promise.race([
    listening.promise.then(() => "слушает"),
    settled,
  ]);
  if (first === "слушает") await whileListening();
  stop.abort();
  return { first, outcome: await settled, stderr: output.stderr() };
}

/** Голый прогон до гашения сигналом; вернуть код и вывод. */
async function bareRun(
  io: CommandIo,
  argv: readonly string[],
  deps: ServiceDeps,
): Promise<{ code: number; stderr: string }> {
  const output = makeOutput();
  const stop = new AbortController();
  const listening = Promise.withResolvers<RunningServer>();
  const running = runMcpServer(argv, {
    io,
    output: output.sink,
    commands,
    log: NO_INVOKE_LOG,
    signal: stop.signal,
    onListen: listening.resolve,
    service: { deps },
    // Не служба: номер свой, а не её главного процесса.
  });
  await listening.promise;
  stop.abort();
  return { code: await running, stderr: output.stderr() };
}

/** Порт службы в конфиге прогона: с него начинается каждая уступка. */
function usePort(io: CommandIo, port: number): void {
  using db = io.openCacheDb();
  setConfigValue(db, "mcp.port", String(port));
}

Deno.test("остановленную службу голое mpu mcp не поднимает после себя", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    // Описание есть, но служба стоит: спека требует не трогать и её.
    await withService(
      { described: true, running: false },
      async (deps, active, calls) => {
        assertEquals((await bareRun(io, [], deps)).code, 0);
        assertEquals(active.now, false, "остановленную службу подняли");
        assertEquals(calls.includes("stop"), false, calls.join(", "));
        assertEquals(calls.includes("start"), false, calls.join(", "));
      },
    );
  });
});

Deno.test("порт, названный флагом тем же, уступки требует", async () => {
  await withStore(async (io) => {
    const wanted = await freePort();
    usePort(io, wanted);
    await withService(
      { described: true },
      async (deps, active, calls) => {
        // Тот же порт, но названный явно: уступка решается сравнением
        // портов, а не отсутствием флага.
        const { code } = await bareRun(io, ["--port", String(wanted)], deps);
        assertEquals(code, 0);
        assertEquals(active.now, true);
        assertEquals(calls.includes("stop"), true, calls.join(", "));
        assertEquals(calls.includes("start"), true, calls.join(", "));
      },
    );
  });
});

Deno.test("службу вернуть не удалось — сказано, где смотреть, и код 1", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService(
      { described: true, brokenStart: true },
      async (deps, active) => {
        const { code, stderr } = await bareRun(io, [], deps);
        // Передний план отработал, но машина осталась изменённой —
        // молчаливый ноль скрыл бы это.
        assertEquals(code, 1);
        assertEquals(active.now, false, "служба всё-таки поднялась");
        assertStringIncludes(stderr, "вернуть не удалось");
        assertStringIncludes(stderr, "mpu mcp status");
      },
    );
  });
});

Deno.test("службу погасили в окне уступки — поднимать её нечем", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    // Между вопросом о состоянии и ответом менеджера служба гаснет
    // сама: уступать оказалось нечего, и поднимать после себя — тоже.
    await withService(
      { described: true, vanishing: true },
      async (deps, active, calls) => {
        const { code, stderr } = await bareRun(io, [], deps);
        assertEquals(code, 0);
        assertEquals(active.now, false, "подняли службу, которая стояла");
        assertEquals(calls.includes("start"), false, calls.join(", "));
        assertEquals(
          stderr.includes("уступлен"),
          false,
          `сказано об уступке, которой не было:\n${stderr}`,
        );
      },
    );
  });
});

Deno.test("дефект своего кода отказом службы не притворяется", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService(
      { described: true, crashStart: true },
      async (deps) => {
        const output = makeOutput();
        const stop = new AbortController();
        const listening = Promise.withResolvers<RunningServer>();
        // Подписка — швом, как у соседей: настоящие обработчики
        // пережили бы этот тест и съели бы Ctrl-C всего прогона.
        let unsubscribed = false;
        const running = runMcpServer([], {
          io,
          output: output.sink,
          commands,
          log: NO_INVOKE_LOG,
          signal: stop.signal,
          onListen: listening.resolve,
          service: { deps },
          onInterrupt: () => () => void (unsubscribed = true),
        });
        await listening.promise;
        stop.abort();
        // Не «службу вернуть не удалось» с кодом 1, а сам дефект наружу:
        // иначе баг был бы неотличим от отказа менеджера.
        await assertRejects(() => running, TypeError, "дефект своего кода");
        assertEquals(
          output.stderr().includes("вернуть не удалось"),
          false,
          output.stderr(),
        );
        // Отказ возврата не отменяет снятия подписки: обработчики
        // сигналов не должны пережить вызов.
        assertEquals(unsubscribed, true, "подписка на сигнал не снята");
      },
    );
  });
});

Deno.test("подписка стоит с начала окна, а второй сигнал убивает", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    // Менеджер — наблюдатель изнутри окна: его зовут ровно тогда, когда
    // окно открыто, и он видит, стояла ли уже подписка.
    const seen: Record<string, boolean | undefined> = {};
    let interrupt: (() => void) | undefined;
    let unsubscribed = false;
    await withService(
      {
        described: true,
        watch: (verb) => {
          if (verb === "stop") seen.atStop = interrupt !== undefined;
          if (verb === "start") seen.atStart = unsubscribed;
        },
      },
      async (deps, active) => {
        const listening = Promise.withResolvers<RunningServer>();
        const running = runMcpServer([], {
          io,
          output: makeOutput().sink,
          commands,
          log: NO_INVOKE_LOG,
          onListen: listening.resolve,
          service: { deps },
          onInterrupt: (handle) => {
            interrupt = handle;
            return () => void (unsubscribed = true);
          },
        });
        await listening.promise;
        assert(interrupt !== undefined, "на прерывание никто не подписался");
        interrupt();
        assertEquals(await running, 0);
        assertEquals(active.now, true);
        // Начало окна: служба ещё останавливается, а обработчик уже
        // стоит — прерывание во время `systemctl stop` перехвачено.
        assertEquals(seen.atStop, true, "подписка поставлена после остановки");
        // Конец окна: первый сигнал уже сработал и снял подписку с
        // себя, поэтому второй убьёт процесс, как убивал до этой
        // спеки. Возврат службы от этого не страдает: он идёт как
        // штатное гашение, а спека требует пережить ОДИН обычный
        // способ закончить работу, не всякое их число.
        assertEquals(seen.atStart, true, "второй сигнал не убьёт процесс");
        assertEquals(unsubscribed, true, "подписка не снята после возврата");
      },
    );
  });
});

Deno.test("порт занят третьим — служба всё равно возвращается", async () => {
  await withStore(async (io) => {
    const wanted = await freePort();
    usePort(io, wanted);
    // Порт держит кто-то посторонний: службу уступили зря, но вернуть
    // её обязаны — иначе она осталась бы лежать из-за чужого процесса.
    const squatter = await serveMcp({
      port: wanted,
      profiles: ["ro"],
      token: "proba",
      deps: {
        io: makeFakeIo(),
        commands,
        log: NO_INVOKE_LOG,
        version: VERSION,
      },
    });
    try {
      await withService(
        { described: true },
        async (deps, active, calls) => {
          const output = makeOutput();
          const code = await runMcpServer([], {
            io,
            output: output.sink,
            commands,
            log: NO_INVOKE_LOG,
            service: { deps },
            onInterrupt: () => () => {},
          });
          assertEquals(code, 1);
          assertStringIncludes(output.stderr(), "занят");
          assertEquals(active.now, true, "служба осталась лежать");
          assertEquals(calls.includes("start"), true, calls.join(", "));
        },
      );
    } finally {
      await squatter.shutdown();
    }
  });
});

Deno.test("запуск, которым исполняется сама служба, уступки не делает", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    // Менеджер называет главным процессом службы этот самый процесс —
    // так и выглядит запуск из юнита, который зовёт тот же голый
    // `mpu mcp`.
    await withService(
      { described: true, self: true },
      async (deps, active, calls) => {
        const output = makeOutput();
        const stop = new AbortController();
        const listening = Promise.withResolvers<RunningServer>();
        const running = runMcpServer([], {
          io,
          output: output.sink,
          commands,
          log: NO_INVOKE_LOG,
          signal: stop.signal,
          onListen: listening.resolve,
          service: { deps },
        });
        await listening.promise;
        stop.abort();
        assertEquals(await running, 0);
        // Служба не остановлена собой и не «возвращена» после себя.
        assertEquals(active.now, true, "служба остановила саму себя");
        assertEquals(calls.includes("stop"), false, calls.join(", "));
        assertEquals(calls.includes("start"), false, calls.join(", "));
        assertEquals(
          output.stderr().includes("уступлен"),
          false,
          output.stderr(),
        );
      },
    );
  });
});

Deno.test("менеджер не назвал главный процесс — порт не уступается", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService({ described: true }, async (deps, active, calls) => {
      // `show` отказал: выяснить, мы ли служба, нечем. Цена ошибки
      // несимметрична, поэтому не уступаем.
      const silent: RunProgram = (bin, args) =>
        args[1] === "show"
          ? Promise.resolve({ code: 1, stdout: "", stderr: "нет такого\n" })
          : deps.run(bin, args);
      const { code } = await bareRun(io, [], { ...deps, run: silent });
      assertEquals(code, 0);
      assertEquals(active.now, true);
      assertEquals(calls.includes("stop"), false, calls.join(", "));
    });
  });
});

Deno.test("менеджер не отвечает на опрос — уступки нет, сервер поднимается", async (t) => {
  // Спросить менеджер не удалось — значит, выяснить не удалось, и уступки
  // нет (`mcp-service.md`, «Граничные случаи и ошибки»). Отказ не обязан
  // всплыть необработанным и уронить запуск.
  const refusals: ReadonlyArray<readonly [string, () => Error]> = [
    [
      "нет права на запуск",
      () => new Deno.errors.NotCapable('Requires run access to "systemctl"'),
    ],
    ["systemctl не найден", () => new Deno.errors.NotFound("systemctl")],
  ];
  for (const [name, refusal] of refusals) {
    await t.step(name, async () => {
      await withStore(async (io) => {
        usePort(io, await freePort());
        await withService({ described: true }, async (deps, active) => {
          const refusing: RunProgram = () => Promise.reject(refusal());
          const output = makeOutput();
          const stop = new AbortController();
          const listening = Promise.withResolvers<RunningServer>();
          const running = runMcpServer([], {
            io,
            output: output.sink,
            commands,
            log: NO_INVOKE_LOG,
            signal: stop.signal,
            onListen: listening.resolve,
            service: { deps: { ...deps, run: refusing } },
          });
          // Наперегонки с завершением: отказавший запуск даёт красный тест
          // с причиной, а не вечное ожидание прослушивания.
          const first = await Promise.race([
            listening.promise.then(() => "слушает"),
            running.then(
              (code) => `завершился с ${code}`,
              (err: unknown) => `отказал: ${String(err)}`,
            ),
          ]);
          stop.abort();
          assertEquals(first, "слушает", output.stderr());
          assertEquals(await running, 0);
          assertEquals(
            output.stderr().includes("уступлен"),
            false,
            output.stderr(),
          );
          assertEquals(active.now, true, "служба тронута");
        });
      });
    });
  }
});

Deno.test("менеджер ответил о состоянии, но не назвал главный процесс отказом — уступки нет", async () => {
  // Второй вопрос опроса — о главном процессе — отказывает сам по себе:
  // служба работает, но выяснить, не мы ли она, нечем, и уступки нет.
  // Отказ на первом же вопросе этот шаг опроса не проверял бы.
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService({ described: true }, async (deps, active, calls) => {
      const refusingShow: RunProgram = (bin, args) =>
        args[1] === "show"
          ? Promise.reject(
            new Deno.errors.NotCapable('Requires run access to "systemctl"'),
          )
          : deps.run(bin, args);
      const output = makeOutput();
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer([], {
        io,
        output: output.sink,
        commands,
        log: NO_INVOKE_LOG,
        signal: stop.signal,
        onListen: listening.resolve,
        service: { deps: { ...deps, run: refusingShow } },
      });
      const first = await Promise.race([
        listening.promise.then(() => "слушает"),
        running.then(
          (code) => `завершился с ${code}`,
          (err: unknown) => `отказал: ${String(err)}`,
        ),
      ]);
      stop.abort();
      assertEquals(first, "слушает", output.stderr());
      assertEquals(await running, 0);
      assertEquals(active.now, true, "служба тронута");
      assertEquals(calls.includes("stop"), false, calls.join(", "));
    });
  });
});

Deno.test("дефект своего кода при опросе менеджера не выдаётся за «уступки нет»", async () => {
  // Глотается только «спросить не удалось»; ошибка программы при опросе
  // обязана всплыть, а не молча поднять сервер.
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService({ described: true }, async (deps) => {
      const broken: RunProgram = () =>
        Promise.reject(new TypeError("дефект своего кода"));
      const stop = new AbortController();
      const listening = Promise.withResolvers<RunningServer>();
      const running = runMcpServer([], {
        io,
        output: makeOutput().sink,
        commands,
        log: NO_INVOKE_LOG,
        signal: stop.signal,
        onListen: listening.resolve,
        service: { deps: { ...deps, run: broken } },
      });
      const first = await Promise.race([
        listening.promise.then(() => "слушает"),
        running.then(
          (code) => `завершился с ${code}`,
          (err: unknown) =>
            err instanceof TypeError ? "дефект всплыл" : String(err),
        ),
      ]);
      stop.abort();
      // Исход уже снят гонкой выше и проверяется ниже; здесь только
      // дожидаемся гашения запуска, чтобы он не пережил тест.
      await running.catch(() => {});
      assertEquals(first, "дефект всплыл");
    });
  });
});

Deno.test("служба остановлена успешно — до возврата менеджер не спрашивают, служба возвращается (и при прерывании)", async (t) => {
  // Строка спеки об отказе опроса сразу после остановки: остановленной без
  // попытки возврата служба не остаётся. Опроса между `stop` и возвратом в
  // пути уступки нет по устройству — отказать там нечему, поэтому держится
  // сам инвариант: после успешного `stop` менеджер молчит до прослушивания,
  // а возврат пробуется и удаётся.
  for (const ending of ["сигнал", "прерывание"] as const) {
    await t.step(ending, async () => {
      await withStore(async (io) => {
        usePort(io, await freePort());
        let stopped = false;
        let listened = false;
        const betweenStopAndListen: string[] = [];
        const watch = (verb: string) => {
          if (stopped && !listened) betweenStopAndListen.push(verb);
          if (verb === "stop") stopped = true;
        };
        await withService(
          { described: true, watch },
          async (deps, active, calls) => {
            const output = makeOutput();
            const stop = new AbortController();
            const listening = Promise.withResolvers<void>();
            let interrupt: (() => void) | undefined;
            const running = runMcpServer([], {
              io,
              output: output.sink,
              commands,
              log: NO_INVOKE_LOG,
              signal: stop.signal,
              onListen: () => {
                listened = true;
                listening.resolve();
              },
              service: { deps },
              onInterrupt: (handle) => {
                interrupt = handle;
                return () => {};
              },
            });
            const first = await Promise.race([
              listening.promise.then(() => "слушает"),
              running.then(
                (code) => `код ${code}`,
                (err: unknown) => `отказал: ${String(err)}`,
              ),
            ]);
            if (ending === "сигнал") stop.abort();
            else interrupt?.();
            const outcome = await running.then(
              (code) => `код ${code}`,
              (err: unknown) => `отказал: ${String(err)}`,
            );
            const stderr = output.stderr();
            assertEquals(first, "слушает", stderr);
            assertStringIncludes(stderr, "уступлен");
            assertEquals(betweenStopAndListen, [], calls.join(", "));
            assertEquals(outcome, "код 0", stderr);
            assertEquals(calls.includes("start"), true, calls.join(", "));
            assertEquals(active.now, true, "служба не вернулась");
          },
        );
      });
    });
  }
});

Deno.test("вернуть службу не удалось отказом в праве — сказано, где смотреть, и код 1", async (t) => {
  // Отказ возврата любого рода — не только ответ менеджера кодом: нет прав
  // на запуск или на чтение описания тоже называются, а не всплывают.
  for (const refusal of ["PermissionDenied", "NotCapable"] as const) {
    await t.step(refusal, async () => {
      await withStore(async (io) => {
        usePort(io, await freePort());
        await withService(
          { described: true, startRefusal: refusal },
          async (deps, active) => {
            const { first, outcome, stderr } = await listenOrFail(io, deps);
            assertEquals(first, "слушает", stderr);
            assertEquals(outcome, "код 1", stderr);
            assertEquals(active.now, false);
            assertStringIncludes(stderr, "вернуть не удалось");
            assertStringIncludes(stderr, "mpu mcp status");
          },
        );
      });
    });
  }
});

/**
 * Предусловие тестов на права: под root `0o000` не мешает чтению, и тест
 * проверял бы не отказ, а обычный путь.
 */
async function assertUnreadable(path: string): Promise<void> {
  await assertRejects(
    () => Deno.readTextFile(path),
    Deno.errors.PermissionDenied,
  );
}

Deno.test("описание службы не читается по правам при возврате — сказано, где смотреть, и код 1", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService({ described: true }, async (deps, active) => {
      const unit = `${deps.dir}/${SERVICE_NAME}`;
      try {
        const { first, outcome, stderr } = await listenOrFail(
          io,
          deps,
          async () => {
            await Deno.chmod(unit, 0o000);
            await assertUnreadable(unit);
          },
        );
        assertEquals(first, "слушает", stderr);
        assertStringIncludes(stderr, "уступлен");
        assertEquals(outcome, "код 1", stderr);
        assertEquals(active.now, false);
        assertStringIncludes(stderr, "вернуть не удалось");
        assertStringIncludes(stderr, "mpu mcp status");
      } finally {
        await Deno.chmod(unit, 0o644);
      }
    });
  });
});

Deno.test("описание службы не читается по правам — выяснить не удалось, уступки нет", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService({ described: true }, async (deps, active, calls) => {
      const unit = `${deps.dir}/${SERVICE_NAME}`;
      await Deno.chmod(unit, 0o000);
      try {
        await assertUnreadable(unit);
        const { first, outcome, stderr } = await listenOrFail(io, deps);
        assertEquals(first, "слушает", stderr);
        assertEquals(outcome, "код 0", stderr);
        assertEquals(active.now, true, "служба тронута");
        assertEquals(calls.includes("stop"), false, calls.join(", "));
      } finally {
        await Deno.chmod(unit, 0o644);
      }
    });
  });
});

Deno.test("опрос перед остановкой отказал — уступки нет, stop не вызывается, сервер поднимается", async () => {
  // Повторная проверка описания и состояния непосредственно перед `stop` —
  // тоже опрос: её отказ значит «выяснить не удалось» (`mcp-service.md`,
  // «Граничные случаи и ошибки»).
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService(
      { described: true, recheckRefusal: true },
      async (deps, active, calls) => {
        const { first, outcome, stderr } = await listenOrFail(io, deps);
        assertEquals(first, "слушает", stderr);
        assertEquals(outcome, "код 0", stderr);
        // След того, что подставной отказ сработал: повторный вопрос был.
        const polls = calls.filter((verb) => verb === "is-active").length;
        assert(polls >= 2, calls.join(", "));
        assertEquals(calls.includes("stop"), false, calls.join(", "));
        assertEquals(stderr.includes("уступлен"), false, stderr);
        assertEquals(active.now, true, "служба тронута");
      },
    );
  });
});

/**
 * Отказ остановки назван, об уступке не сказано, и строка отказа стоит
 * раньше строки возврата: спека требует «отказ, затем возврат».
 */
function assertStopRefusedThenReturn(stderr: string, returned: string): void {
  const refused = stderr.indexOf("остановить службу не удалось");
  assert(refused >= 0, stderr);
  assertEquals(stderr.includes("уступлен"), false, stderr);
  const back = stderr.indexOf(returned);
  assert(back >= 0, stderr);
  assert(refused < back, `возврат назван раньше отказа остановки:\n${stderr}`);
}

Deno.test("stop отказал — сервер не поднимается, отказ назван, возврат пробуется, код 1", async (t) => {
  await t.step(
    "нет права на запуск: служба работает, возврат её не меняет",
    async () => {
      await withStore(async (io) => {
        usePort(io, await freePort());
        await withService(
          { described: true, stopRefusal: true },
          async (deps, active, calls) => {
            const { first, stderr } = await listenOrFail(io, deps);
            assertEquals(first, "код 1", stderr);
            assertStringIncludes(
              stderr,
              "mpu mcp: остановить службу не удалось: Requires run access",
            );
            assertEquals(stderr.includes("слушаю"), false, stderr);
            // Возврат пробовали: после отказавшего `stop` менеджер спрошен.
            assert(
              calls.indexOf("stop") < calls.lastIndexOf("is-active"),
              calls.join(", "),
            );
            assertStopRefusedThenReturn(stderr, "возвращать нечего");
            assertEquals(active.now, true);
          },
        );
      });
    },
  );

  await t.step(
    "ненулевой код, а служба погасла: возврат её поднимает",
    async () => {
      await withStore(async (io) => {
        usePort(io, await freePort());
        await withService(
          { described: true, brokenStop: true },
          async (deps, active, calls) => {
            const { first, stderr } = await listenOrFail(io, deps);
            assertEquals(first, "код 1", stderr);
            assertStringIncludes(
              stderr,
              "mpu mcp: остановить службу не удалось: systemctl --user stop",
            );
            assertEquals(stderr.includes("слушаю"), false, stderr);
            assertStopRefusedThenReturn(stderr, "запущена снова");
            assertEquals(calls.includes("start"), true, calls.join(", "));
            assertEquals(active.now, true, "служба осталась лежать");
          },
        );
      });
    },
  );

  await t.step("и возврат отказал — ещё строка про возврат", async () => {
    await withStore(async (io) => {
      usePort(io, await freePort());
      await withService(
        { described: true, brokenStop: true, startRefusal: "NotCapable" },
        async (deps, active) => {
          const { first, stderr } = await listenOrFail(io, deps);
          assertEquals(first, "код 1", stderr);
          assertStopRefusedThenReturn(stderr, "вернуть не удалось");
          assertStringIncludes(stderr, "mpu mcp status");
          assertEquals(active.now, false);
        },
      );
    });
  });

  await t.step("дефект своего кода при остановке всплывает", async () => {
    await withStore(async (io) => {
      usePort(io, await freePort());
      await withService(
        { described: true, crashStop: true },
        async (deps) => {
          const { first, stderr } = await listenOrFail(io, deps);
          assertStringIncludes(first, "отказал: TypeError", stderr);
          assertEquals(stderr.includes("остановить службу"), false, stderr);
        },
      );
    });
  });
});

Deno.test("дефект своего кода на повторном опросе перед остановкой всплывает", async () => {
  // Глотается только «спросить не удалось»; ошибка программы на повторной
  // проверке перед `stop` — не «уступки нет».
  await withStore(async (io) => {
    usePort(io, await freePort());
    await withService(
      { described: true, recheckCrash: true },
      async (deps, active, calls) => {
        const { first, stderr } = await listenOrFail(io, deps);
        assertStringIncludes(first, "отказал: TypeError", stderr);
        // След того, что отказ пришёлся именно на повторный вопрос.
        const polls = calls.filter((verb) => verb === "is-active").length;
        assert(polls >= 2, calls.join(", "));
        assertEquals(calls.includes("stop"), false, calls.join(", "));
        assertEquals(active.now, true, "служба тронута");
      },
    );
  });
});

Deno.test("прерывание до остановки службы — уступки нет, stop не вызывается, сервер не поднимается", async (t) => {
  // Прерывание приходит во время каждого из опросов перед уступкой; опрос
  // отвечает, когда отпустит тест, — без снов.
  const polls = [
    ["первый вопрос о состоянии", "is-active", 1],
    ["вопрос о главном процессе", "show", 1],
    ["повторный вопрос о состоянии", "is-active", 2],
  ] as const;
  for (const [name, verb, nth] of polls) {
    await t.step(name, async () => {
      await withStore(async (io) => {
        usePort(io, await freePort());
        const release = Promise.withResolvers<void>();
        const pollBegun = Promise.withResolvers<void>();
        let seen = 0;
        await withService(
          {
            described: true,
            pollGate: { verb, nth, gate: release.promise },
            watch: (called) => {
              if (called === verb && ++seen === nth) pollBegun.resolve();
            },
          },
          async (deps, active, calls) => {
            const output = makeOutput();
            const listening = Promise.withResolvers<RunningServer>();
            let interrupt: (() => void) | undefined;
            const running = runMcpServer([], {
              io,
              output: output.sink,
              commands,
              log: NO_INVOKE_LOG,
              onListen: listening.resolve,
              service: { deps },
              onInterrupt: (handle) => {
                interrupt = handle;
                return () => {};
              },
            });
            const settled = running.then(
              (code) => `код ${code}`,
              (err: unknown) => `отказал: ${String(err)}`,
            );
            await Promise.race([pollBegun.promise, settled]);
            interrupt?.();
            release.resolve();
            const first = await Promise.race([
              listening.promise.then(() => "слушает"),
              settled,
            ]);
            // Сервер, поднятый вопреки прерыванию, сам не гаснет: гасим его
            // здесь, чтобы тест краснел, а не висел.
            if (first === "слушает") {
              await (await listening.promise).shutdown();
            }
            const outcome = await settled;
            const stderr = output.stderr();
            assert(
              interrupt !== undefined,
              "на прерывание никто не подписался",
            );
            assertEquals(first, "код 0", stderr);
            assertEquals(outcome, "код 0", stderr);
            assertEquals(stderr.includes("слушаю"), false, stderr);
            assertEquals(calls.includes("stop"), false, calls.join(", "));
            assertEquals(calls.includes("start"), false, calls.join(", "));
            assertEquals(active.now, true, "служба тронута");
          },
        );
      });
    });
  }
});

Deno.test("прерывание во время остановки службы — сервер не поднимается, служба возвращается", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    // `stop` отвечает, когда отпустит тест: прерывание приходит ровно в
    // окне остановки, без снов.
    const release = Promise.withResolvers<void>();
    const stopBegun = Promise.withResolvers<void>();
    await withService(
      {
        described: true,
        stopGate: release.promise,
        watch: (verb) => void (verb === "stop" && stopBegun.resolve()),
      },
      async (deps, active, calls) => {
        const output = makeOutput();
        const listening = Promise.withResolvers<RunningServer>();
        let interrupt: (() => void) | undefined;
        const running = runMcpServer([], {
          io,
          output: output.sink,
          commands,
          log: NO_INVOKE_LOG,
          onListen: listening.resolve,
          service: { deps },
          onInterrupt: (handle) => {
            interrupt = handle;
            return () => {};
          },
        });
        const settled = running.then(
          (code) => `код ${code}`,
          (err: unknown) => `отказал: ${String(err)}`,
        );
        await Promise.race([stopBegun.promise, settled]);
        interrupt?.();
        release.resolve();
        const first = await Promise.race([
          listening.promise.then(() => "слушает"),
          settled,
        ]);
        // Сервер, поднятый вопреки прерыванию, сам не гаснет: гасим его
        // здесь, чтобы тест краснел, а не висел.
        if (first === "слушает") await (await listening.promise).shutdown();
        const outcome = await settled;
        const stderr = output.stderr();
        assert(interrupt !== undefined, "на прерывание никто не подписался");
        assertEquals(first, "код 0", stderr);
        assertEquals(outcome, "код 0", stderr);
        assertEquals(stderr.includes("слушаю"), false, stderr);
        assertEquals(calls.includes("start"), true, calls.join(", "));
        assertEquals(active.now, true, "служба не вернулась");
      },
    );
  });
});

Deno.test("подписка на сигнал живёт весь запуск, даже без уступки", async () => {
  await withStore(async (io) => {
    usePort(io, await freePort());
    // Службы нет — уступать нечего, но гаснуть по сигналу сервер
    // обязан всё равно: убитый сигналом процесс выходит ненулевым
    // кодом, и менеджер увидел бы `failed` вместо «остановлена».
    await withService({ described: false }, async (deps) => {
      const listening = Promise.withResolvers<RunningServer>();
      let interrupt: (() => void) | undefined;
      let unsubscribed = false;
      const running = runMcpServer([], {
        io,
        output: makeOutput().sink,
        commands,
        log: NO_INVOKE_LOG,
        onListen: listening.resolve,
        service: { deps },
        onInterrupt: (handle) => {
          interrupt = handle;
          return () => void (unsubscribed = true);
        },
      });
      await listening.promise;
      assertEquals(unsubscribed, false, "отписались, не дождавшись конца");
      assert(interrupt !== undefined, "на прерывание никто не подписался");
      interrupt();
      assertEquals(await running, 0);
      assertEquals(unsubscribed, true, "подписка не снята после выхода");
    });
  });
});
