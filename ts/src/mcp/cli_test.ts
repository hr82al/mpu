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
    await fn(real, dir);
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
    calls.push(verb);
    watch(verb);
    if (quirks.vanishing && asked) active.now = false;
    if (verb === "start" && quirks.crashStart) {
      return Promise.reject(new TypeError("дефект своего кода"));
    }
    if (verb === "start" && quirks.brokenStart) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "порт занят\n" });
    }
    if (verb === "stop") active.now = false;
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
    return Promise.resolve({ code: 0, stdout: `${answer}\n`, stderr: "" });
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
