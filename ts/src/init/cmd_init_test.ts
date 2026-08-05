/**
 * Тесты команды `mpu init`, шаги 1–2 (`docs/specs/init.md`, порция А).
 * Команда не публикуется в реестре (маршрут остаётся `legacy`), поэтому
 * вызывается напрямую через объявление (`initCommand.invoke`), а не
 * через `runCli`. Обвязка `invokeInit` ниже собирает вывод ровно так,
 * как это делает точка входа (`src/entrypoint/mod.ts`): строки
 * `progress` уходят в stderr по ходу исполнения, класс ошибки — в код
 * выхода, `formatCommandError` формирует последнюю строку отказа.
 *
 * Фейковый Portainer-сервер поднимается на петле (`Deno.serve`,
 * `port: 0`) — калька вспомогательной функции `portainer_test.ts`;
 * общего тестового модуля под неё нет (два места, YAGNI), см. отчёт.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type CommandIo,
  DomainError,
  type EnvFile,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { initCommand, requirePortainerAccess, runInit } from "./cmd_init.ts";
import {
  HEADERS_TIMEOUT_MS,
  type PortainerAccess,
  TOTAL_TIMEOUT_MS,
} from "./portainer.ts";

const API_KEY = "proba-portainer-key-K7x9Qz";

/** Поднимает фейковый Portainer на петле; гасить `await stop()` в `finally`. */
function fakeServer(
  handler: (req: Request) => Response | Promise<Response>,
): { readonly baseUrl: string; readonly stop: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    stop: () => server.shutdown(),
  };
}

function endpointsResponse(
  endpoints: ReadonlyArray<{ id: number; name: string }>,
): Response {
  return Response.json(endpoints.map((e) => ({ Id: e.id, Name: e.name })));
}

interface FakeContainer {
  readonly id: string;
  readonly names: readonly string[];
  readonly state: string;
  readonly image: string;
}

function containersResponse(containers: readonly FakeContainer[]): Response {
  return Response.json(containers.map((c) => ({
    Id: c.id,
    Names: c.names,
    State: c.state,
    Image: c.image,
  })));
}

function envFileFake(values: Readonly<Record<string, string>> = {}): EnvFile {
  return {
    get: (name) => values[name],
    require: () => {
      throw new Error("envFile.require must not be touched");
    },
    set: () => {
      throw new Error("envFile.set must not be touched");
    },
  };
}

function makeIo(
  dbPath: string,
  overrides: Partial<CommandIo> = {},
): CommandIo {
  return makeFakeIo({
    openCacheDb: () => openCacheDb(dbPath),
    ...overrides,
  });
}

interface Invocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Исполняет `initCommand` напрямую и собирает вывод обеих точек: та же
 * склейка, что даёт `runCli` (см. заголовок файла), без обхода реестра.
 */
async function invokeInit(
  argv: readonly string[],
  io: CommandIo,
): Promise<Invocation> {
  const progress: string[] = [];
  const wrapped: CommandIo = {
    ...io,
    progress: (line) => progress.push(`${line}\n`),
  };
  try {
    const result = await initCommand.invoke(argv, wrapped);
    return {
      stdout: initCommand.renderResult(result, argv),
      stderr: progress.join(""),
      code: initCommand.textExitCode(result),
    };
  } catch (err) {
    if (err instanceof UsageError) {
      return {
        stdout: "",
        stderr: progress.join("") + formatCommandError(["init"], err) + "\n",
        code: 2,
      };
    }
    if (err instanceof DomainError) {
      return {
        stdout: "",
        stderr: progress.join("") + formatCommandError(["init"], err) + "\n",
        code: 1,
      };
    }
    throw err;
  }
}

async function withTempDb(
  fn: (dbPath: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/mpu.db`, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("golden: нет PORTAINER_API_KEY", async () => {
  await withTempDb(async (dbPath) => {
    const io = makeIo(dbPath, { envFile: envFileFake({}) });
    const outcome = await invokeInit([], io);
    const expected = (await Deno.readTextFile(
      new URL("testdata/err-no-api-key.txt", import.meta.url),
    )).replace("<путь к кэш-БД>", dbPath);
    assertEquals(outcome.stderr, expected);
    assertEquals(outcome.code, 2);
  });
});

Deno.test("golden: нет --portainer и PORTAINER_URL", async () => {
  await withTempDb(async (dbPath) => {
    const io = makeIo(dbPath, {
      envFile: envFileFake({ PORTAINER_API_KEY: API_KEY }),
    });
    const outcome = await invokeInit([], io);
    const expected = (await Deno.readTextFile(
      new URL("testdata/err-no-url.txt", import.meta.url),
    )).replace("<путь к кэш-БД>", dbPath);
    assertEquals(outcome.stderr, expected);
    assertEquals(outcome.code, 2);
  });
});

Deno.test("requirePortainerAccess: приоритет --portainer, PORTAINER_VERIFY_TLS, нормализация URL", async (t) => {
  interface Case {
    readonly name: string;
    readonly args: { readonly portainer?: string };
    readonly env: Readonly<Record<string, string>>;
    readonly expected: PortainerAccess;
  }
  const cases: readonly Case[] = [
    {
      name: "--portainer приоритетнее PORTAINER_URL (шаг 2 спеки)",
      args: { portainer: "https://cli.example.com" },
      env: {
        PORTAINER_API_KEY: API_KEY,
        PORTAINER_URL: "https://env.example.com",
      },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: "без --portainer используется PORTAINER_URL",
      args: {},
      env: {
        PORTAINER_API_KEY: API_KEY,
        PORTAINER_URL: "https://env.example.com",
      },
      expected: {
        baseUrl: "https://env.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: "хвостовые / базового URL срезаются",
      args: { portainer: "https://cli.example.com///" },
      env: { PORTAINER_API_KEY: API_KEY },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: "PORTAINER_VERIFY_TLS не задан — verifyTls выключен",
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name: 'PORTAINER_VERIFY_TLS="true" — verifyTls включён',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "true" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: true,
      },
    },
    {
      name: 'PORTAINER_VERIFY_TLS="false" — verifyTls выключен',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "false" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
    {
      name:
        'PORTAINER_VERIFY_TLS="1" — verifyTls выключен (сравнение только со строкой "true")',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "1" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: false,
      },
    },
  ];
  for (const c of cases) {
    await t.step(c.name, () => {
      assertEquals(
        requirePortainerAccess(c.args, envFileFake(c.env)),
        c.expected,
      );
    });
  }
});

Deno.test("happy path: сводка, запись в кэш, sl-строки по возрастанию server_number", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "prod" }]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        // Порядок в ответе — умышленно не по возрастанию номера: сводка
        // обязана пересортировать, а не полагаться на порядок Portainer.
        return containersResponse([
          { id: "c3", names: ["/sl-3-cli"], state: "running", image: "img" },
          { id: "c1", names: ["/sl-1-cli"], state: "exited", image: "img" },
          {
            id: "cx",
            names: ["/wb-loader-1"],
            state: "running",
            image: "img",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stdout,
        "# найдено sl-N контейнеров: 2\n" +
          `sl-1: sl-1-cli [exited] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          `sl-3: sl-3-cli [running] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          "# прочих контейнеров: 1\n" +
          `# записано 3 контейнеров в ${dbPath}\n`,
      );
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n`,
      );

      using db = openCacheDb(dbPath);
      const rows = db.query(
        "SELECT container_id, container_name, server_number, portainer_url, endpoint_id FROM portainer_containers ORDER BY container_id",
      );
      assertEquals(rows, [
        {
          container_id: "c1",
          container_name: "sl-1-cli",
          server_number: 1,
          portainer_url: baseUrl,
          endpoint_id: 1,
        },
        {
          container_id: "c3",
          container_name: "sl-3-cli",
          server_number: 3,
          portainer_url: baseUrl,
          endpoint_id: 1,
        },
        {
          container_id: "cx",
          container_name: "wb-loader-1",
          server_number: null,
          portainer_url: baseUrl,
          endpoint_id: 1,
        },
      ]);
    } finally {
      await stop();
    }
  });
});

Deno.test("sl-строки сортируются по server_number независимо от порядка обхода endpoints", async () => {
  await withTempDb(async (dbPath) => {
    // endpoint 1 (обходится первым по id) отдаёт больший номер, чем
    // endpoint 2 — сортировка вывода обязана быть по номеру, не по id.
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "e1" }, {
          id: 2,
          name: "e2",
        }]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        return containersResponse([
          { id: "c9", names: ["/sl-9-cli"], state: "running", image: "img" },
        ]);
      }
      if (url.pathname === "/api/endpoints/2/docker/containers/json") {
        return containersResponse([
          { id: "c2", names: ["/sl-2-cli"], state: "running", image: "img" },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit(["--dry-run"], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stdout,
        "# найдено sl-N контейнеров: 2\n" +
          `sl-2: sl-2-cli [running] @ endpoint 2 (e2) -> ${baseUrl}/2\n` +
          `sl-9: sl-9-cli [running] @ endpoint 1 (e1) -> ${baseUrl}/1\n` +
          "# прочих контейнеров: 0\n",
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("обход endpoints конкурентный: оба запроса пришли раньше, чем сервер ответил хотя бы на один", async () => {
  await withTempDb(async (dbPath) => {
    // Каждый обработчик endpoint'а держит ответ, пока не пришли ОБА
    // запроса: при последовательном обходе (`for`/`await` вместо
    // `Promise.allSettled`) второй запрос не будет отправлен, пока не
    // ответит первый — а первый ждёт второй запрос. Тупик снимается
    // только конкурентной отправкой обоих вызовов.
    let arrivals = 0;
    const both = Promise.withResolvers<void>();
    const { baseUrl, stop } = fakeServer(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "e1" }, {
          id: 2,
          name: "e2",
        }]);
      }
      if (
        url.pathname === "/api/endpoints/1/docker/containers/json" ||
        url.pathname === "/api/endpoints/2/docker/containers/json"
      ) {
        arrivals++;
        if (arrivals === 2) both.resolve();
        await both.promise;
        const n = url.pathname.includes("/1/") ? 1 : 2;
        return containersResponse([
          {
            id: `c${n}`,
            names: [`/sl-${n}-cli`],
            state: "running",
            image: "img",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit(["--dry-run"], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stdout,
        "# найдено sl-N контейнеров: 2\n" +
          `sl-1: sl-1-cli [running] @ endpoint 1 (e1) -> ${baseUrl}/1\n` +
          `sl-2: sl-2-cli [running] @ endpoint 2 (e2) -> ${baseUrl}/2\n` +
          "# прочих контейнеров: 0\n",
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("ошибка одного endpoint'а: строка в stderr, обход продолжается, остальные записаны", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "bad" }, {
          id: 2,
          name: "good",
        }]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        return new Response("upstream error", { status: 502 });
      }
      if (url.pathname === "/api/endpoints/2/docker/containers/json") {
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (bad): HTTP 502\n",
      );
      assertEquals(
        outcome.stdout,
        "# найдено sl-N контейнеров: 1\n" +
          `sl-1: sl-1-cli [running] @ endpoint 2 (good) -> ${baseUrl}/2\n` +
          "# прочих контейнеров: 0\n" +
          `# записано 1 контейнеров в ${dbPath}\n`,
      );

      // Инвариант init.md «обрыв не теряет уже собранное»: собранное с
      // здорового endpoint'а реально в БД, а не только в тексте сводки.
      using db = openCacheDb(dbPath);
      assertEquals(
        db.query(
          "SELECT container_id, endpoint_id FROM portainer_containers",
        ),
        [{ container_id: "c1", endpoint_id: 2 }],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("ошибки нескольких endpoints — строки в stderr по возрастанию id", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        // Список отдаётся не по возрастанию id — сортировка вывода не
        // должна полагаться на порядок ответа Portainer.
        return endpointsResponse([{ id: 5, name: "e5" }, {
          id: 2,
          name: "e2",
        }]);
      }
      return new Response("boom", { status: 500 });
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      // Оба endpoint'а упали → контейнеров ноль → exit 1, но обе строки
      // ошибок обязаны быть напечатаны до отказа, в порядке id 2, затем 5.
      assertEquals(outcome.code, 1);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 2 (e2): HTTP 500\n" +
          "mpu init: endpoint 5 (e5): HTTP 500\n" +
          "mpu init: ни одного контейнера не найдено\n",
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("таймаут молчащего endpoint'а: строка ошибки, обход продолжается, время ограничено", async () => {
  await withTempDb(async (dbPath) => {
    const pending = Promise.withResolvers<Response>();
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "silent" }, {
          id: 2,
          name: "fine",
        }]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        return pending.promise; // никогда не резолвится сам по себе
      }
      if (url.pathname === "/api/endpoints/2/docker/containers/json") {
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    try {
      const progress: string[] = [];
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
        progress: (line) => void progress.push(`${line}\n`),
      });
      // Шаги 1–2 зовутся напрямую, потому что предел заголовков здесь
      // уменьшен на два порядка: через объявление команды он равен
      // продуктовым трём секундам, и тест ждал бы их стеной (`ts/CLAUDE.md`
      // такой сон запрещает). Продуктовые числа проверяет тест `--help`.
      const timeouts = { headersTimeoutMs: 60, totalTimeoutMs: 5_000 };
      const start = performance.now();
      const result = await runInit(
        { portainer: undefined, "dry-run": true, reset: false },
        io,
        timeouts,
      );
      const elapsed = performance.now() - start;
      assertEquals(
        progress.join(""),
        `# bootstrap: схема в ${dbPath} готова\n` +
          `mpu init: endpoint 1 (silent): no response headers within ` +
          `${timeouts.headersTimeoutMs}ms\n`,
      );
      assertEquals(
        initCommand.renderResult(result, ["--dry-run"]),
        "# найдено sl-N контейнеров: 1\n" +
          `sl-1: sl-1-cli [running] @ endpoint 2 (fine) -> ${baseUrl}/2\n` +
          "# прочих контейнеров: 0\n",
      );
      // Обход уложился в предел заголовков молчащего endpoint'а, а не в
      // общий предел вызова: запас на неспешную машину — тридцатикратный.
      assertEquals(
        elapsed < 2_000,
        true,
        `elapsed ${elapsed}ms должно быть < 2000ms`,
      );
    } finally {
      pending.resolve(new Response("[]"));
      await stop();
    }
  });
});

Deno.test("0 sl-контейнеров при непустых прочих — не ошибка: сводка с нулём", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "prod" }]);
      }
      return containersResponse([
        { id: "cx", names: ["/wb-loader-1"], state: "running", image: "img" },
        { id: "cy", names: ["/mp-nginx"], state: "exited", image: "img" },
      ]);
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      // Спека, «Граничные случаи»: ноль sl-контейнеров при непустом списке
      // прочих — не ошибка, шаги 3–5 выполняются.
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stdout,
        "# найдено sl-N контейнеров: 0\n" +
          "# прочих контейнеров: 2\n" +
          `# записано 2 контейнеров в ${dbPath}\n`,
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query("SELECT COUNT(*) AS n FROM portainer_containers"),
        [{ n: 2 }],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("exit 1: сбой списка endpoints", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer(() =>
      new Response("nope", { status: 500 })
    );
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 1);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: portainer: HTTP 500\n",
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("exit 1: ни одного контейнера не найдено", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "empty" }]);
      }
      return containersResponse([]);
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 1);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: ни одного контейнера не найдено\n",
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query("SELECT COUNT(*) AS n FROM portainer_containers"),
        [{ n: 0 }],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("--dry-run: кэш не изменяется, сводка та же, без строки # записано", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "prod" }]);
      }
      return containersResponse([
        { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
      ]);
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit(["--dry-run"], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stdout,
        "# найдено sl-N контейнеров: 1\n" +
          `sl-1: sl-1-cli [running] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          "# прочих контейнеров: 0\n",
      );
      assertEquals(outcome.stdout.includes("# записано"), false);

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query("SELECT COUNT(*) AS n FROM portainer_containers"),
        [{ n: 0 }],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("запись в кэш: image и endpoint_name дословны, discovered_at — unix-секунды", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 7, name: "custom-endpoint-name" }]);
      }
      return containersResponse([
        {
          id: "c1",
          names: ["/sl-1-cli"],
          state: "running",
          image: "registry.example.com/sl:1.2.3",
        },
      ]);
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      // Диапазон, не точное равенство: `discovered_at` берётся один раз
      // на прогон где-то между этими двумя отметками (init.md, шаг 2).
      const before = Math.floor(Date.now() / 1000);
      const outcome = await invokeInit([], io);
      const after = Math.floor(Date.now() / 1000);
      assertEquals(outcome.code, 0);

      using db = openCacheDb(dbPath);
      const rows = db.query(
        "SELECT image, endpoint_name, discovered_at FROM portainer_containers WHERE container_id = ?",
        "c1",
      );
      assertEquals(rows.length, 1);
      const row = rows[0];
      assertEquals(row.image, "registry.example.com/sl:1.2.3");
      assertEquals(row.endpoint_name, "custom-endpoint-name");
      const discoveredAt = Number(row.discovered_at);
      assertEquals(
        discoveredAt >= before && discoveredAt <= after,
        true,
        `discovered_at ${discoveredAt} должен быть unix-секундами в ` +
          `диапазоне [${before}, ${after}] — мс вместо с дал бы число вне диапазона`,
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("--reset: удаляет старые записи перед записью новых", async () => {
  await withTempDb(async (dbPath) => {
    let containers: readonly FakeContainer[] = [
      { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
      { id: "c2", names: ["/sl-2-cli"], state: "running", image: "img" },
    ];
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "prod" }]);
      }
      return containersResponse(containers);
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const first = await invokeInit([], io);
      assertEquals(first.code, 0);

      containers = [
        { id: "c3", names: ["/sl-3-cli"], state: "running", image: "img" },
      ];
      const second = await invokeInit(["--reset"], io);
      assertEquals(second.code, 0);
      assertEquals(
        second.stdout,
        "# найдено sl-N контейнеров: 1\n" +
          `sl-3: sl-3-cli [running] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          "# прочих контейнеров: 0\n" +
          "# --reset: удалено 2 старых записей\n" +
          `# записано 1 контейнеров в ${dbPath}\n`,
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query("SELECT container_id FROM portainer_containers"),
        [{ container_id: "c3" }],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test(
  "--reset: сбой во время upsert не теряет прежний кэш — DELETE и запись в одной транзакции",
  async () => {
    await withTempDb(async (dbPath) => {
      // Второй прогон отдаёт контейнер без поля Id — намеренно битые
      // данные с провода (тип клиента их не проверяет, см. `portainer.ts`
      // про JSON.parse без рантайм-схемы); биндинг такого параметра
      // node:sqlite бросает TypeError внутри upsert. Тест проверяет
      // инвариант preserve: DELETE не должен пережить откат upsert'а.
      let broken = false;
      const { baseUrl, stop } = fakeServer((req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/endpoints") {
          return endpointsResponse([{ id: 1, name: "prod" }]);
        }
        if (!broken) {
          return containersResponse([
            { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
          ]);
        }
        return Response.json([
          { Names: ["/sl-2-cli"], State: "running", Image: "img" },
        ]);
      });
      try {
        const io = makeIo(dbPath, {
          envFile: envFileFake({
            PORTAINER_API_KEY: API_KEY,
            PORTAINER_URL: baseUrl,
          }),
          // Прямой вызов `runInit` ниже (в обход `invokeInit`) сам не
          // оборачивает `progress` — фейк по умолчанию (`makeFakeIo`)
          // бросает на любом обращении, а строка шага 1 печатается до
          // DELETE/upsert и замаскировала бы проверяемое исключение.
          progress: () => {},
        });
        assertEquals((await invokeInit([], io)).code, 0);

        broken = true;
        let threw = false;
        try {
          await runInit(
            { portainer: undefined, "dry-run": false, reset: true },
            io,
          );
        } catch {
          threw = true;
        }
        assertEquals(
          threw,
          true,
          "упавший upsert обязан пробросить исключение",
        );

        using db = openCacheDb(dbPath);
        assertEquals(
          db.query("SELECT container_id FROM portainer_containers"),
          [{ container_id: "c1" }],
          "прежний кэш обязан пережить упавшую попытку --reset",
        );
      } finally {
        await stop();
      }
    });
  },
);

Deno.test("повторный прогон без --reset: дублей нет, stale-запись остаётся", async () => {
  await withTempDb(async (dbPath) => {
    let containers: readonly FakeContainer[] = [
      { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
      { id: "c2", names: ["/sl-2-cli"], state: "running", image: "img" },
    ];
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "prod" }]);
      }
      return containersResponse(containers);
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      assertEquals((await invokeInit([], io)).code, 0);

      // Второй прогон видит только c2 (c1 «исчез» из Portainer) и без
      // --reset — c1 обязан остаться в кэше (вердикт preserve спеки).
      containers = [
        { id: "c2", names: ["/sl-2-cli"], state: "exited", image: "img" },
      ];
      const second = await invokeInit([], io);
      assertEquals(second.code, 0);

      using db = openCacheDb(dbPath);
      const rows = db.query(
        "SELECT container_id, state FROM portainer_containers ORDER BY container_id",
      );
      // Ровно две строки — c2 обновилась (upsert), не задублировалась.
      assertEquals(rows, [
        { container_id: "c1", state: "running" },
        { container_id: "c2", state: "exited" },
      ]);
    } finally {
      await stop();
    }
  });
});

Deno.test("секреты: API-ключ не появляется ни в stdout, ни в stderr", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([{ id: 1, name: "prod" }]);
      }
      return containersResponse([
        { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
      ]);
    });
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.stdout.includes(API_KEY), false);
      assertEquals(outcome.stderr.includes(API_KEY), false);
    } finally {
      await stop();
    }
  });
});

Deno.test("--help содержит числа таймаутов и укладывается в 2048 байт с summary", () => {
  assertEquals(initCommand.help.includes(String(HEADERS_TIMEOUT_MS)), true);
  assertEquals(initCommand.help.includes(String(TOTAL_TIMEOUT_MS)), true);
  assertNotEquals(HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS);
  const bytes = new TextEncoder().encode(
    `${initCommand.summary}\n\n${initCommand.help}`,
  ).length;
  assertEquals(bytes <= 2048, true, `описание не влезло: ${bytes} байт`);
});
