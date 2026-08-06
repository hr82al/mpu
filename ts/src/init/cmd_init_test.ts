/**
 * Тесты команды `mpu init` (`docs/specs/init.md`). Команда лежит в
 * реестре маршрутом `native`, поэтому вызывается через точку входа
 * (`runCli`) — так проверяется вся склейка: разбор argv, печать
 * результата, служебные строки `progress` в stderr и перевод классов
 * ошибок в коды выхода.
 *
 * Фейковые серверы (Portainer, Loki, Kaiten) поднимаются на петле
 * (`Deno.serve`, `port: 0`) — калька вспомогательной функции
 * `portainer_test.ts`; общего тестового модуля под неё нет (несколько
 * мест с разной формой ответов, YAGNI), см. отчёт.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type CommandIo,
  type EnvFile,
  NotFoundIoError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  DEFAULT_INIT_LIMITS,
  initCommand,
  requirePortainerAccess,
  runInit,
} from "./cmd_init.ts";
import { HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "../http/mod.ts";
import type { PortainerAccess } from "../portainer/mod.ts";
import { WARMUP_BUDGET_MS } from "../kaiten/mod.ts";

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

/** `status` по умолчанию 1 (доступен) — большинству тестов down не нужен. */
function endpointsResponse(
  endpoints: ReadonlyArray<
    { id: number; name: string; status?: number }
  >,
): Response {
  return Response.json(
    endpoints.map((e) => ({ Id: e.id, Name: e.name, Status: e.status ?? 1 })),
  );
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
    values: () => ({ ...values }),
  };
}

/**
 * Окружение прогона. Шаг 5 по умолчанию отрабатывает успешно и потому
 * молчит: его отказы проверяются отдельными тестами, а в остальных он
 * только шумел бы в ожидаемом stderr.
 */
function makeIo(
  dbPath: string,
  overrides: Partial<CommandIo> = {},
): CommandIo {
  return makeFakeIo({
    openCacheDb: () => openCacheDb(dbPath),
    runLegacyInteractive: () => Promise.resolve(0),
    ...overrides,
  });
}

interface Invocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Исполняет `mpu init` через точку входа и собирает оба потока. */
async function invokeInit(
  argv: readonly string[],
  io: CommandIo,
): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["init", ...argv], io, {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  return { stdout: out.join(""), stderr: err.join(""), code };
}

/**
 * Строки шагов 3–4 при незаданных ключах: прогревы пропускаются, и это
 * штатный исход для тестов, которые проверяют шаги 1–2.
 */
const WARMUP_SKIPPED = "# loki: пропущено (LOKI_URL не задан)\n" +
  "# kaiten: пропущено (KITEN_API_KEY не задан)\n";

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
      name:
        'PORTAINER_VERIFY_TLS="True" — verifyTls включён (без учёта регистра)',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "True" },
      expected: {
        baseUrl: "https://cli.example.com",
        apiKey: API_KEY,
        verifyTls: true,
      },
    },
    {
      name:
        'PORTAINER_VERIFY_TLS="TRUE" — verifyTls включён (без учёта регистра)',
      args: { portainer: "https://cli.example.com" },
      env: { PORTAINER_API_KEY: API_KEY, PORTAINER_VERIFY_TLS: "TRUE" },
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
        'PORTAINER_VERIFY_TLS="1" — verifyTls выключен (сравнение без учёта регистра, но не с "1")',
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
          "# прочих контейнеров: 1\n",
      );
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 3 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
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
          "mpu init: endpoint 1 (bad): HTTP 502\n" +
          `# записано 1 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
      );
      assertEquals(
        outcome.stdout,
        "# найдено sl-N контейнеров: 1\n" +
          `sl-1: sl-1-cli [running] @ endpoint 2 (good) -> ${baseUrl}/2\n` +
          "# прочих контейнеров: 0\n",
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
      const limits = {
        timeouts: { headersTimeoutMs: 60, totalTimeoutMs: 5_000 },
        budgetMs: DEFAULT_INIT_LIMITS.budgetMs,
      };
      const start = performance.now();
      const result = await runInit(
        { portainer: undefined, "dry-run": true, reset: false },
        io,
        limits,
      );
      const elapsed = performance.now() - start;
      assertEquals(
        progress.join(""),
        `# bootstrap: схема в ${dbPath} готова\n` +
          `mpu init: endpoint 1 (silent): no response headers within ` +
          `${limits.timeouts.headersTimeoutMs}ms\n`,
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
          "# прочих контейнеров: 2\n",
      );
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 2 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
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
          "# прочих контейнеров: 0\n",
      );
      assertEquals(
        second.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# --reset: удалено 2 старых записей\n" +
          `# записано 1 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
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
      // node:sqlite бросает TypeError внутри upsert. Тест проверяет два
      // инварианта: preserve (DELETE не должен пережить откат upsert'а) и
      // «строка --reset печатается только после коммита» (init.md,
      // шаг 2) — упавшая транзакция не должна оставить эту строку в
      // выводе.
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
        const capturedProgress: string[] = [];
        const io = makeIo(dbPath, {
          envFile: envFileFake({
            PORTAINER_API_KEY: API_KEY,
            PORTAINER_URL: baseUrl,
          }),
          // Прямой вызов `runInit` ниже (в обход `invokeInit`) сам не
          // оборачивает `progress` — фейк по умолчанию (`makeFakeIo`)
          // бросает на любом обращении. Строки собираются вместо
          // отбрасывания: помимо того, что это не маскирует проверяемое
          // исключение, так видно, дошла ли строка `--reset` до печати
          // при откаченной транзакции.
          progress: (line) => void capturedProgress.push(line),
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
        assertEquals(
          capturedProgress,
          [`# bootstrap: схема в ${dbPath} готова`],
          "строка --reset не должна печататься при откаченной транзакции",
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

Deno.test("повторный прогон без --reset: дублей нет, пропавший с endpoint'а контейнер реконсилируется", async () => {
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

      // Второй прогон видит только c2 (c1 пропал с живого endpoint'а) —
      // реконсиляция обязана убрать c1 из кэша (init.md, шаг 2, «fix»).
      containers = [
        { id: "c2", names: ["/sl-2-cli"], state: "exited", image: "img" },
      ];
      const second = await invokeInit([], io);
      assertEquals(second.code, 0);
      assertEquals(
        second.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      const rows = db.query(
        "SELECT container_id, state FROM portainer_containers ORDER BY container_id",
      );
      // Ровно одна строка — c1 реконсилирован, c2 обновилась (upsert).
      assertEquals(rows, [{ container_id: "c2", state: "exited" }]);
    } finally {
      await stop();
    }
  });
});

Deno.test("down-endpoint: строка пропуска без опроса, реконсиляция удаляет его записи, чужой portainer_url цел", async () => {
  await withTempDb(async (dbPath) => {
    let statusOfOne = 1;
    let endpoint1Requests = 0;
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "prod", status: statusOfOne },
          { id: 2, name: "stage" },
        ]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        endpoint1Requests++;
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
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
      // Чужой portainer_url — реконсиляция текущего прогона его не касается.
      using seedDb = openCacheDb(dbPath);
      seedDb.bootstrap();
      seedDb.execute(
        `INSERT INTO portainer_containers (portainer_url, endpoint_id,
          endpoint_name, container_id, container_name, server_number, state,
          image, discovered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "https://other.example.com",
        1,
        "other",
        "co",
        "sl-1-cli",
        1,
        "running",
        "img",
        1,
      );

      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      assertEquals((await invokeInit([], io)).code, 0);
      assertEquals(endpoint1Requests, 1);

      statusOfOne = 2;
      const second = await invokeInit([], io);
      assertEquals(second.code, 0);
      assertEquals(
        second.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (prod): down — пропущен\n" +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
      );
      assertEquals(
        endpoint1Requests,
        1,
        "down-endpoint не должен быть опрошен повторно",
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query(
          "SELECT portainer_url, endpoint_id, container_id FROM " +
            "portainer_containers ORDER BY portainer_url, container_id",
        ),
        [
          { portainer_url: baseUrl, endpoint_id: 2, container_id: "c2" },
          {
            portainer_url: "https://other.example.com",
            endpoint_id: 1,
            container_id: "co",
          },
        ],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("endpoint исчез из списка endpoints: реконсиляция удаляет его записи", async () => {
  await withTempDb(async (dbPath) => {
    let includeSecond = true;
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        const list = [{ id: 1, name: "prod" }];
        if (includeSecond) list.push({ id: 2, name: "stage" });
        return endpointsResponse(list);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
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
      assertEquals((await invokeInit([], io)).code, 0);

      includeSecond = false;
      const second = await invokeInit([], io);
      assertEquals(second.code, 0);
      assertEquals(
        second.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query(
          "SELECT endpoint_id, container_id FROM portainer_containers",
        ),
        [{ endpoint_id: 1, container_id: "c1" }],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("все контейнеры пропали с успешно обойдённого endpoint'а: реконсиляция чистит их все", async () => {
  await withTempDb(async (dbPath) => {
    let containers2: readonly FakeContainer[] = [
      { id: "c2", names: ["/sl-2-cli"], state: "running", image: "img" },
    ];
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "prod" },
          { id: 2, name: "stage" },
        ]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
        ]);
      }
      if (url.pathname === "/api/endpoints/2/docker/containers/json") {
        return containersResponse(containers2);
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
      assertEquals((await invokeInit([], io)).code, 0);

      // Endpoint 2 сам обойдён успешно (пустой список — не ошибка), но
      // контейнеров на нём больше нет — реконсиляция обязана убрать все.
      containers2 = [];
      const second = await invokeInit([], io);
      assertEquals(second.code, 0);
      assertEquals(
        second.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query(
          "SELECT endpoint_id, container_id FROM portainer_containers",
        ),
        [{ endpoint_id: 1, container_id: "c1" }],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("сорвавшийся endpoint: записи целы, реконсиляция его не касается", async () => {
  await withTempDb(async (dbPath) => {
    let endpoint1Fails = false;
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "prod" },
          { id: 2, name: "stage" },
        ]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        if (endpoint1Fails) {
          return new Response("upstream error", { status: 502 });
        }
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
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
      assertEquals((await invokeInit([], io)).code, 0);

      endpoint1Fails = true;
      const second = await invokeInit([], io);
      assertEquals(second.code, 0);
      // Без строки «# удалено» — сорвавшийся обход ничего не реконсилирует.
      assertEquals(
        second.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (prod): HTTP 502\n" +
          `# записано 1 контейнеров в ${dbPath}\n` + WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query(
          "SELECT endpoint_id, container_id FROM portainer_containers " +
            "ORDER BY endpoint_id",
        ),
        [
          { endpoint_id: 1, container_id: "c1" },
          { endpoint_id: 2, container_id: "c2" },
        ],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("--dry-run: не удаляет ничего, даже когда endpoint стал down", async () => {
  await withTempDb(async (dbPath) => {
    let statusOfOne = 1;
    const { baseUrl, stop } = fakeServer((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "prod", status: statusOfOne },
          { id: 2, name: "stage" },
        ]);
      }
      if (url.pathname === "/api/endpoints/1/docker/containers/json") {
        return containersResponse([
          { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
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
      assertEquals((await invokeInit([], io)).code, 0);

      statusOfOne = 2;
      const dryRun = await invokeInit(["--dry-run"], io);
      assertEquals(dryRun.code, 0);
      assertEquals(
        dryRun.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (prod): down — пропущен\n",
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        db.query(
          "SELECT endpoint_id, container_id FROM portainer_containers " +
            "ORDER BY endpoint_id",
        ),
        [
          { endpoint_id: 1, container_id: "c1" },
          { endpoint_id: 2, container_id: "c2" },
        ],
        "--dry-run обязан оставить кэш нетронутым, включая записи down-endpoint'а",
      );
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

Deno.test("--help содержит числа пределов и укладывается в 2048 байт с summary", () => {
  assertEquals(initCommand.help.includes(String(HEADERS_TIMEOUT_MS)), true);
  assertEquals(initCommand.help.includes(String(TOTAL_TIMEOUT_MS)), true);
  assertEquals(initCommand.help.includes(String(WARMUP_BUDGET_MS)), true);
  assertNotEquals(HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS);
  assertNotEquals(TOTAL_TIMEOUT_MS, WARMUP_BUDGET_MS);
  const bytes = new TextEncoder().encode(
    `${initCommand.summary}\n\n${initCommand.help}`,
  ).length;
  assertEquals(bytes <= 2048, true, `описание не влезло: ${bytes} байт`);
});

// --- шаги 3–5 и модель исполнения -------------------------------------

/** Пространства стенда: две доски, чтобы обход частей 2–3 был не вырожден. */
const STAND_SPACES = [{
  id: 101,
  title: "Разработка",
  archived: false,
  boards: [
    { id: 501, space_id: 101, title: "Основная доска" },
    { id: 502, space_id: 101, title: "Баги" },
  ],
}];

const STAND_LANES: Readonly<Record<string, unknown[]>> = {
  "501": [
    { id: 9001, board_id: 501, title: "Обычные" },
    { id: 9002, board_id: 501, title: "Срочные" },
  ],
  "502": [{ id: 9101, board_id: 502, title: "Обычные" }],
};

const STAND_COLUMNS: Readonly<Record<string, unknown[]>> = {
  "501": [
    { id: 7001, board_id: 501, title: "Очередь", sort_order: 1 },
    { id: 7002, board_id: 501, title: "В работе", sort_order: 2 },
  ],
  "502": [{ id: 7101, board_id: 502, title: "Очередь", sort_order: 1 }],
};

const STAND_ROLES = [{ id: 11, name: "Разработка" }, {
  id: 12,
  name: "Аналитика",
}];

/** Ответ series: два хоста, две пары (у одной записи сервиса нет). */
const STAND_SERIES = {
  status: "success",
  data: [
    { host: "sl-1", compose_service: "api" },
    { host: "sl-2", compose_service: "api" },
    { host: "sl-1" },
  ],
};

const STAND_CONTAINERS: readonly FakeContainer[] = [
  { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
];

/** Сводки прогревов стенда — их же ждут тесты порядка и конкурентности. */
const STAND_WARMUP_LINES = "# loki: 2 hosts, 2 (host, service) пар\n" +
  "# kaiten: 1 spaces, 2 boards, 3 lanes, 3 columns, 2 roles\n";

/** Доска из пути `/api/latest/boards/<id>/<что>`; путь не тот — undefined. */
function boardOf(pathname: string, what: string): string | undefined {
  const match = new RegExp(`^/api/latest/boards/(\\d+)/${what}$`).exec(
    pathname,
  );
  return match === null ? undefined : match[1];
}

/**
 * Один фейковый стенд на все три источника: пути не пересекаются, а
 * тесту достаточно одного порта и одного `stop()`. `hook` подменяет
 * ответ по пути (вернул undefined — берётся ответ стенда по умолчанию).
 */
function fakeStand(
  hook: (url: URL) => Response | Promise<Response | undefined> | undefined =
    () => undefined,
) {
  return fakeServer(async (req) => {
    const url = new URL(req.url);
    const hooked = await hook(url);
    if (hooked !== undefined) return hooked;
    if (url.pathname === "/api/endpoints") {
      return endpointsResponse([{ id: 1, name: "prod" }]);
    }
    if (url.pathname === "/api/endpoints/1/docker/containers/json") {
      return containersResponse(STAND_CONTAINERS);
    }
    if (url.pathname === "/loki/api/v1/series") {
      return Response.json(STAND_SERIES);
    }
    if (url.pathname === "/api/latest/spaces") {
      return Response.json(STAND_SPACES);
    }
    if (url.pathname === "/api/latest/user-roles") {
      return Response.json(STAND_ROLES);
    }
    const lanes = boardOf(url.pathname, "lanes");
    if (lanes !== undefined) return Response.json(STAND_LANES[lanes] ?? []);
    const columns = boardOf(url.pathname, "columns");
    if (columns !== undefined) {
      return Response.json(STAND_COLUMNS[columns] ?? []);
    }
    return new Response(null, { status: 404 });
  });
}

/** Окружение стенда: все три источника — на одном базовом URL. */
function standEnv(baseUrl: string): EnvFile {
  return envFileFake({
    PORTAINER_API_KEY: API_KEY,
    PORTAINER_URL: baseUrl,
    LOKI_URL: baseUrl,
    KITEN_API_KEY: "proba-kiten-key-Q3w8Ee",
    KITEN_BASE_URL: baseUrl,
  });
}

Deno.test("happy path со всеми шагами: блоки stderr идут в порядке 1..5", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeStand();
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          STAND_WARMUP_LINES,
      );
      // Шаг 5 отработал с нулевым кодом — строки о нём нет (спека).
      assertEquals(outcome.stderr.includes("# telegram"), false);

      using db = openCacheDb(dbPath);
      const count = (table: string) =>
        Number(db.query(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
      assertEquals(count("loki_hosts"), 2);
      assertEquals(count("loki_services_by_host"), 2);
      assertEquals(count("kaiten_spaces"), 1);
      assertEquals(count("kaiten_boards"), 2);
      assertEquals(count("kaiten_lanes"), 3);
      assertEquals(count("kaiten_columns"), 3);
      assertEquals(count("kaiten_roles"), 2);
    } finally {
      await stop();
    }
  });
});

Deno.test("порядок блоков не зависит от порядка завершения шагов", async () => {
  await withTempDb(async (dbPath) => {
    // Loki отвечает строго ПОСЛЕ того, как Kaiten дочитан: шаг 3
    // завершается последним, но его блок обязан стоять перед блоком 4.
    const rolesServed = Promise.withResolvers<void>();
    const { baseUrl, stop } = fakeStand((url) => {
      if (url.pathname === "/api/latest/user-roles") {
        rolesServed.resolve();
        return undefined;
      }
      if (url.pathname === "/loki/api/v1/series") {
        return rolesServed.promise.then(() => Response.json(STAND_SERIES));
      }
      return undefined;
    });
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          STAND_WARMUP_LINES,
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("шаги 2–4 конкурентны: три запроса пришли раньше первого ответа", async () => {
  await withTempDb(async (dbPath) => {
    // Каждый из трёх обработчиков держит ответ, пока не пришли все три.
    // При последовательном исполнении шагов это тупик: второй запрос не
    // уйдёт, пока не ответит первый, а первый ждёт остальных.
    let arrivals = 0;
    const all = Promise.withResolvers<void>();
    const gate = async () => {
      arrivals++;
      if (arrivals === 3) all.resolve();
      await all.promise;
    };
    const { baseUrl, stop } = fakeStand((url) => {
      const first = url.pathname === "/api/endpoints/1/docker/containers/json";
      if (
        !first && url.pathname !== "/loki/api/v1/series" &&
        url.pathname !== "/api/latest/spaces"
      ) {
        return undefined;
      }
      return gate().then(() => undefined);
    });
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      assertEquals(arrivals >= 3, true, `запросов пришло ${arrivals}`);
    } finally {
      await stop();
    }
  });
});

Deno.test("--dry-run: шаги 3–5 не выполняются вовсе", async () => {
  await withTempDb(async (dbPath) => {
    const touched: string[] = [];
    const { baseUrl, stop } = fakeStand((url) => {
      if (
        url.pathname !== "/api/endpoints" &&
        !url.pathname.startsWith("/api/endpoints/1/")
      ) {
        touched.push(url.pathname);
      }
      return undefined;
    });
    try {
      let interactive = 0;
      const io = makeIo(dbPath, {
        envFile: standEnv(baseUrl),
        runLegacyInteractive: () => {
          interactive++;
          return Promise.resolve(0);
        },
      });
      const outcome = await invokeInit(["--dry-run"], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n`,
      );
      assertEquals(touched, [], "прогревы ходили в сеть при --dry-run");
      assertEquals(interactive, 0, "шаг 5 запускался при --dry-run");
    } finally {
      await stop();
    }
  });
});

Deno.test("шаг 5: ненулевой код и несостоявшийся запуск — строка пропуска, exit 0", async (t) => {
  const cases: readonly (readonly [string, Partial<CommandIo>, string])[] = [
    [
      "ненулевой код возврата",
      { runLegacyInteractive: () => Promise.resolve(3) },
      "# telegram: пропущено (код возврата 3)\n",
    ],
    [
      "подпроцесс не запустился",
      {
        runLegacyInteractive: () =>
          Promise.reject(new NotFoundIoError('cannot run "/nowhere/mpu"')),
      },
      "# telegram: пропущено (legacy-реализация не найдена по пути " +
      '"/nowhere/mpu")\n',
    ],
  ];
  for (const [name, override, expected] of cases) {
    await t.step(name, async () => {
      await withTempDb(async (dbPath) => {
        const { baseUrl, stop } = fakeStand();
        try {
          const io = makeIo(dbPath, {
            envFile: standEnv(baseUrl),
            readConfigStore: () =>
              Promise.resolve(JSON.stringify({
                values: { "mcp.legacy_bin": "/nowhere/mpu" },
              })),
            ...override,
          });
          const outcome = await invokeInit([], io);
          // Исход шага 5 код выхода init не меняет (спека).
          assertEquals(outcome.code, 0);
          assertEquals(
            outcome.stderr,
            `# bootstrap: схема в ${dbPath} готова\n` +
              `# записано 1 контейнеров в ${dbPath}\n` +
              STAND_WARMUP_LINES + expected,
          );
        } finally {
          await stop();
        }
      });
    });
  }
});

Deno.test("шаг 5 начинается строго после шагов 2–4", async () => {
  await withTempDb(async (dbPath) => {
    const order: string[] = [];
    const { baseUrl, stop } = fakeStand((url) => {
      order.push(url.pathname);
      return undefined;
    });
    try {
      const io = makeIo(dbPath, {
        envFile: standEnv(baseUrl),
        runLegacyInteractive: () => {
          order.push("telegram");
          return Promise.resolve(0);
        },
      });
      assertEquals((await invokeInit([], io)).code, 0);
      assertEquals(
        order[order.length - 1],
        "telegram",
        `шаг 5 не последний: ${JSON.stringify(order)}`,
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("пропуск одной доски Kaiten: строка и scoped-запись остальных", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeStand((url) => {
      if (boardOf(url.pathname, "lanes") === "502") {
        return new Response("boom", { status: 500 });
      }
      return undefined;
    });
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: 2 hosts, 2 (host, service) пар\n" +
          "# kaiten: доска 502: пропущена " +
          "(kaiten GET /boards/502/lanes -> 500: boom)\n" +
          "# kaiten: 1 spaces, 2 boards, 2 lanes, 3 columns, 2 roles\n",
      );

      // Собранное по здоровой доске записано, обход не оборван.
      using db = openCacheDb(dbPath);
      assertEquals(
        db.query("SELECT id FROM kaiten_lanes ORDER BY id"),
        [{ id: 9001 }, { id: 9002 }],
      );
      assertEquals(
        Number(db.query("SELECT COUNT(*) AS n FROM kaiten_columns")[0].n),
        3,
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("часть 2 Kaiten упала целиком: счётчик в сводке — «?»", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeStand((url) =>
      boardOf(url.pathname, "lanes") === undefined
        ? undefined
        : new Response("boom", { status: 500 })
    );
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      // Ноль от «?» отличается: пустой справочник — не то же самое, что
      // справочник, о котором ничего не известно (init.md, шаг 4).
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: 2 hosts, 2 (host, service) пар\n" +
          "# kaiten: доска 501: пропущена " +
          "(kaiten GET /boards/501/lanes -> 500: boom)\n" +
          "# kaiten: доска 502: пропущена " +
          "(kaiten GET /boards/502/lanes -> 500: boom)\n" +
          "# kaiten: 1 spaces, 2 boards, ? lanes, 3 columns, 2 roles\n",
      );

      // Упавшая целиком часть кэш дорожек не трогает вовсе.
      using db = openCacheDb(dbPath);
      assertEquals(
        Number(db.query("SELECT COUNT(*) AS n FROM kaiten_lanes")[0].n),
        0,
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("прогрев Loki упал: строка пропуска, остальные шаги отработали", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = fakeStand((url) =>
      url.pathname === "/loki/api/v1/series"
        ? new Response("nope", { status: 503 })
        : undefined
    );
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      assertEquals(outcome.code, 0);
      assertEquals(
        outcome.stderr,
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: пропущено (HTTP 503)\n" +
          "# kaiten: 1 spaces, 2 boards, 3 lanes, 3 columns, 2 roles\n",
      );

      using db = openCacheDb(dbPath);
      assertEquals(
        Number(db.query("SELECT COUNT(*) AS n FROM loki_hosts")[0].n),
        0,
        "упавший прогрев не должен трогать кэш Loki",
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("молчащий источник прогрева не тянет команду дольше своего предела", async () => {
  await withTempDb(async (dbPath) => {
    const pending = Promise.withResolvers<Response>();
    const { baseUrl, stop } = fakeStand((url) =>
      url.pathname === "/loki/api/v1/series" ? pending.promise : undefined
    );
    try {
      const progress: string[] = [];
      const io = makeIo(dbPath, {
        envFile: standEnv(baseUrl),
        progress: (line) => void progress.push(`${line}\n`),
      });
      // Пределы уменьшены на два порядка: ждать продуктовые секунды
      // стеной тест не имеет права (`ts/CLAUDE.md`).
      const limits = {
        timeouts: { headersTimeoutMs: 60, totalTimeoutMs: 5_000 },
        budgetMs: DEFAULT_INIT_LIMITS.budgetMs,
      };
      const start = performance.now();
      await runInit(
        { portainer: undefined, "dry-run": false, reset: false },
        io,
        limits,
      );
      const elapsed = performance.now() - start;
      assertEquals(
        progress.join(""),
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: пропущено (no response headers within 60ms)\n" +
          "# kaiten: 1 spaces, 2 boards, 3 lanes, 3 columns, 2 roles\n",
      );
      assertEquals(
        elapsed < 2_000,
        true,
        `elapsed ${elapsed}ms должно быть < 2000ms`,
      );
    } finally {
      pending.resolve(new Response("{}"));
      await stop();
    }
  });
});

Deno.test("URL Portainer без схемы — ошибка конфигурации, exit 2", async (t) => {
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    [
      "флагом --portainer",
      ["--portainer", "portainer.example.com"],
      "portainer.example.com",
    ],
    ["ключом PORTAINER_URL", [], "10.0.0.7:9443"],
  ];
  for (const [name, argv, value] of cases) {
    await t.step(name, async () => {
      await withTempDb(async (dbPath) => {
        const io = makeIo(dbPath, {
          envFile: envFileFake({
            PORTAINER_API_KEY: API_KEY,
            PORTAINER_URL: value,
          }),
        });
        const outcome = await invokeInit(argv, io);
        assertEquals(outcome.code, 2);
        assertEquals(
          outcome.stderr,
          `# bootstrap: схема в ${dbPath} готова\n` +
            `mpu init: некорректный URL Portainer: '${value}' — ` +
            "нужна схема http:// или https://\n",
        );
      });
    });
  }
});
