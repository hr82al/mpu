/**
 * Сценарии команды `mpu init` (`docs/specs/init.md`) через точку входа
 * (`runCli`): команда лежит в реестре маршрутом `native`, так проверяется
 * вся склейка — разбор argv, печать результата, служебные строки
 * `progress` в stderr и перевод классов ошибок в коды выхода. Случаи без
 * точки входа — в пакете `@mpu/cmd-init`.
 *
 * Фейковые серверы (Portainer, Loki, Kaiten) и env-файл — стенд пакета
 * (`@mpu/cmd-init/testing`); эталоны — канал `docs/specs/fixtures/init/`.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { CommandIo } from "@mpu/command";
import { plainRows } from "@mpu/command/testing";
import { openCacheDb } from "@mpu/command/store";
import { serveFetch } from "@mpu/testing";
import { initCommand } from "@mpu/cmd-init";
import {
  API_KEY,
  boardOf,
  containersResponse,
  endpointsResponse,
  envFileFake,
  type FakeContainer,
  fakeStand,
  makeIo,
  STAND_SERIES,
  STAND_WARMUP_LINES,
  standEnv,
  TELEGRAM_SKIPPED,
  WARMUP_SKIPPED,
  withTempDb,
} from "@mpu/cmd-init/testing";
import { runCli } from "../mod.ts";

/** Эталон канала `docs/specs/fixtures/init/`. */
const golden = (name: string): URL =>
  new URL(`../../../../docs/specs/fixtures/init/${name}`, import.meta.url);

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

it("golden: нет PORTAINER_API_KEY", async () => {
  await withTempDb(async (dbPath) => {
    const io = makeIo(dbPath, { envFile: envFileFake({}) });
    const outcome = await invokeInit([], io);
    const expected = (
      await readFile(golden("err-no-api-key.txt"), "utf8")
    ).replace("<путь к кэш-БД>", dbPath);
    expect(outcome.stderr).toStrictEqual(expected);
    expect(outcome.code).toBe(2);
  });
});

it("golden: нет --portainer и PORTAINER_URL", async () => {
  await withTempDb(async (dbPath) => {
    const io = makeIo(dbPath, {
      envFile: envFileFake({ PORTAINER_API_KEY: API_KEY }),
    });
    const outcome = await invokeInit([], io);
    const expected = (await readFile(golden("err-no-url.txt"), "utf8")).replace(
      "<путь к кэш-БД>",
      dbPath,
    );
    expect(outcome.stderr).toStrictEqual(expected);
    expect(outcome.code).toBe(2);
  });
});

it("happy path: сводка, запись в кэш, sl-строки по возрастанию server_number", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toStrictEqual(
        "# найдено sl-N контейнеров: 2\n" +
          `sl-1: sl-1-cli [exited] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          `sl-3: sl-3-cli [running] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          "# прочих контейнеров: 1\n",
      );
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 3 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      const rows = plainRows(
        db.query(
          "SELECT container_id, container_name, server_number, portainer_url, endpoint_id FROM portainer_containers ORDER BY container_id",
        ),
      );
      expect(rows).toStrictEqual([
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

it("sl-строки сортируются по server_number независимо от порядка обхода endpoints", async () => {
  await withTempDb(async (dbPath) => {
    // endpoint 1 (обходится первым по id) отдаёт больший номер, чем
    // endpoint 2 — сортировка вывода обязана быть по номеру, не по id.
    const { baseUrl, stop } = await serveFetch((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "e1" },
          {
            id: 2,
            name: "e2",
          },
        ]);
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
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toStrictEqual(
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

it("обход endpoints конкурентный: оба запроса пришли раньше, чем сервер ответил хотя бы на один", async () => {
  await withTempDb(async (dbPath) => {
    // Каждый обработчик endpoint'а держит ответ, пока не пришли ОБА
    // запроса: при последовательном обходе (`for`/`await` вместо
    // `Promise.allSettled`) второй запрос не будет отправлен, пока не
    // ответит первый — а первый ждёт второй запрос. Тупик снимается
    // только конкурентной отправкой обоих вызовов.
    let arrivals = 0;
    const both = Promise.withResolvers<void>();
    const { baseUrl, stop } = await serveFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "e1" },
          {
            id: 2,
            name: "e2",
          },
        ]);
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
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toStrictEqual(
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

it("ошибка одного endpoint'а: строка в stderr, обход продолжается, остальные записаны", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        return endpointsResponse([
          { id: 1, name: "bad" },
          {
            id: 2,
            name: "good",
          },
        ]);
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
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (bad): HTTP 502\n" +
          `# записано 1 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );
      expect(outcome.stdout).toStrictEqual(
        "# найдено sl-N контейнеров: 1\n" +
          `sl-1: sl-1-cli [running] @ endpoint 2 (good) -> ${baseUrl}/2\n` +
          "# прочих контейнеров: 0\n",
      );

      // Инвариант init.md «обрыв не теряет уже собранное»: собранное с
      // здорового endpoint'а реально в БД, а не только в тексте сводки.
      using db = openCacheDb(dbPath);
      expect(
        plainRows(
          db.query(
            "SELECT container_id, endpoint_id FROM portainer_containers",
          ),
        ),
      ).toStrictEqual([{ container_id: "c1", endpoint_id: 2 }]);
    } finally {
      await stop();
    }
  });
});

it("ошибки нескольких endpoints — строки в stderr по возрастанию id", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/endpoints") {
        // Список отдаётся не по возрастанию id — сортировка вывода не
        // должна полагаться на порядок ответа Portainer.
        return endpointsResponse([
          { id: 5, name: "e5" },
          {
            id: 2,
            name: "e2",
          },
        ]);
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
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toStrictEqual(
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

it("0 sl-контейнеров при непустых прочих — не ошибка: сводка с нулём", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toStrictEqual(
        "# найдено sl-N контейнеров: 0\n" + "# прочих контейнеров: 2\n",
      );
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 2 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      expect(
        plainRows(db.query("SELECT COUNT(*) AS n FROM portainer_containers")),
      ).toStrictEqual([{ n: 2 }]);
    } finally {
      await stop();
    }
  });
});

it("exit 1: сбой списка endpoints", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch(
      () => new Response("nope", { status: 500 }),
    );
    try {
      const io = makeIo(dbPath, {
        envFile: envFileFake({
          PORTAINER_API_KEY: API_KEY,
          PORTAINER_URL: baseUrl,
        }),
      });
      const outcome = await invokeInit([], io);
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: portainer: HTTP 500\n",
      );
    } finally {
      await stop();
    }
  });
});

it("exit 1: ни одного контейнера не найдено", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: ни одного контейнера не найдено\n",
      );

      using db = openCacheDb(dbPath);
      expect(
        plainRows(db.query("SELECT COUNT(*) AS n FROM portainer_containers")),
      ).toStrictEqual([{ n: 0 }]);
    } finally {
      await stop();
    }
  });
});

it("--dry-run: кэш не изменяется, сводка та же, без строки # записано", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toStrictEqual(
        "# найдено sl-N контейнеров: 1\n" +
          `sl-1: sl-1-cli [running] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          "# прочих контейнеров: 0\n",
      );
      expect(outcome.stdout.includes("# записано")).toBe(false);

      using db = openCacheDb(dbPath);
      expect(
        plainRows(db.query("SELECT COUNT(*) AS n FROM portainer_containers")),
      ).toStrictEqual([{ n: 0 }]);
    } finally {
      await stop();
    }
  });
});

it("запись в кэш: image и endpoint_name дословны, discovered_at — unix-секунды", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect(outcome.code).toBe(0);

      using db = openCacheDb(dbPath);
      const rows = plainRows(
        db.query(
          "SELECT image, endpoint_name, discovered_at FROM portainer_containers WHERE container_id = ?",
          "c1",
        ),
      );
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.image).toBe("registry.example.com/sl:1.2.3");
      expect(row.endpoint_name).toBe("custom-endpoint-name");
      const discoveredAt = Number(row.discovered_at);
      expect(
        discoveredAt >= before && discoveredAt <= after,
        `discovered_at ${discoveredAt} должен быть unix-секундами в ` +
          `диапазоне [${before}, ${after}] — мс вместо с дал бы число вне диапазона`,
      ).toBe(true);
    } finally {
      await stop();
    }
  });
});

it("--reset: удаляет старые записи перед записью новых", async () => {
  await withTempDb(async (dbPath) => {
    let containers: readonly FakeContainer[] = [
      { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
      { id: "c2", names: ["/sl-2-cli"], state: "running", image: "img" },
    ];
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect(first.code).toBe(0);

      containers = [
        { id: "c3", names: ["/sl-3-cli"], state: "running", image: "img" },
      ];
      const second = await invokeInit(["--reset"], io);
      expect(second.code).toBe(0);
      expect(second.stdout).toStrictEqual(
        "# найдено sl-N контейнеров: 1\n" +
          `sl-3: sl-3-cli [running] @ endpoint 1 (prod) -> ${baseUrl}/1\n` +
          "# прочих контейнеров: 0\n",
      );
      expect(second.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# reset: удалено 2 старых записей\n" +
          `# записано 1 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      expect(
        plainRows(db.query("SELECT container_id FROM portainer_containers")),
      ).toStrictEqual([{ container_id: "c3" }]);
    } finally {
      await stop();
    }
  });
});

it("--reset: сбой во время upsert не теряет прежний кэш — DELETE и запись в одной транзакции", async () => {
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
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect((await invokeInit([], io)).code).toBe(0);

      broken = true;
      let threw = false;
      try {
        await initCommand.invokeInput(
          { portainer: undefined, "dry-run": false, reset: true },
          io,
        );
      } catch {
        threw = true;
      }
      expect(threw, "упавший upsert обязан пробросить исключение").toBe(true);
      expect(
        capturedProgress,
        "строка --reset не должна печататься при откаченной транзакции",
      ).toStrictEqual([`# bootstrap: схема в ${dbPath} готова`]);

      using db = openCacheDb(dbPath);
      expect(
        plainRows(db.query("SELECT container_id FROM portainer_containers")),
        "прежний кэш обязан пережить упавшую попытку --reset",
      ).toStrictEqual([{ container_id: "c1" }]);
    } finally {
      await stop();
    }
  });
});

it("повторный прогон без --reset: дублей нет, пропавший с endpoint'а контейнер реконсилируется", async () => {
  await withTempDb(async (dbPath) => {
    let containers: readonly FakeContainer[] = [
      { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
      { id: "c2", names: ["/sl-2-cli"], state: "running", image: "img" },
    ];
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect((await invokeInit([], io)).code).toBe(0);

      // Второй прогон видит только c2 (c1 пропал с живого endpoint'а) —
      // реконсиляция обязана убрать c1 из кэша (init.md, шаг 2, «fix»).
      containers = [
        { id: "c2", names: ["/sl-2-cli"], state: "exited", image: "img" },
      ];
      const second = await invokeInit([], io);
      expect(second.code).toBe(0);
      expect(second.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      const rows = plainRows(
        db.query(
          "SELECT container_id, state FROM portainer_containers ORDER BY container_id",
        ),
      );
      // Ровно одна строка — c1 реконсилирован, c2 обновилась (upsert).
      expect(rows).toStrictEqual([{ container_id: "c2", state: "exited" }]);
    } finally {
      await stop();
    }
  });
});

it("down-endpoint: строка пропуска без опроса, реконсиляция удаляет его записи, чужой portainer_url цел", async () => {
  await withTempDb(async (dbPath) => {
    let statusOfOne = 1;
    let endpoint1Requests = 0;
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect((await invokeInit([], io)).code).toBe(0);
      expect(endpoint1Requests).toBe(1);

      statusOfOne = 2;
      const second = await invokeInit([], io);
      expect(second.code).toBe(0);
      expect(second.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (prod): down — пропущен\n" +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );
      expect(
        endpoint1Requests,
        "down-endpoint не должен быть опрошен повторно",
      ).toBe(1);

      using db = openCacheDb(dbPath);
      expect(
        plainRows(
          db.query(
            "SELECT portainer_url, endpoint_id, container_id FROM " +
              "portainer_containers ORDER BY portainer_url, container_id",
          ),
        ),
      ).toStrictEqual([
        { portainer_url: baseUrl, endpoint_id: 2, container_id: "c2" },
        {
          portainer_url: "https://other.example.com",
          endpoint_id: 1,
          container_id: "co",
        },
      ]);
    } finally {
      await stop();
    }
  });
});

it("endpoint исчез из списка endpoints: реконсиляция удаляет его записи", async () => {
  await withTempDb(async (dbPath) => {
    let includeSecond = true;
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect((await invokeInit([], io)).code).toBe(0);

      includeSecond = false;
      const second = await invokeInit([], io);
      expect(second.code).toBe(0);
      expect(second.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      expect(
        plainRows(
          db.query(
            "SELECT endpoint_id, container_id FROM portainer_containers",
          ),
        ),
      ).toStrictEqual([{ endpoint_id: 1, container_id: "c1" }]);
    } finally {
      await stop();
    }
  });
});

it("все контейнеры пропали с успешно обойдённого endpoint'а: реконсиляция чистит их все", async () => {
  await withTempDb(async (dbPath) => {
    let containers2: readonly FakeContainer[] = [
      { id: "c2", names: ["/sl-2-cli"], state: "running", image: "img" },
    ];
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect((await invokeInit([], io)).code).toBe(0);

      // Endpoint 2 сам обойдён успешно (пустой список — не ошибка), но
      // контейнеров на нём больше нет — реконсиляция обязана убрать все.
      containers2 = [];
      const second = await invokeInit([], io);
      expect(second.code).toBe(0);
      expect(second.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "# удалено устаревших записей: 1\n" +
          `# записано 1 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      expect(
        plainRows(
          db.query(
            "SELECT endpoint_id, container_id FROM portainer_containers",
          ),
        ),
      ).toStrictEqual([{ endpoint_id: 1, container_id: "c1" }]);
    } finally {
      await stop();
    }
  });
});

it("сорвавшийся endpoint: записи целы, реконсиляция его не касается", async () => {
  await withTempDb(async (dbPath) => {
    let endpoint1Fails = false;
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect((await invokeInit([], io)).code).toBe(0);

      endpoint1Fails = true;
      const second = await invokeInit([], io);
      expect(second.code).toBe(0);
      // Без строки «# удалено» — сорвавшийся обход ничего не реконсилирует.
      expect(second.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (prod): HTTP 502\n" +
          `# записано 1 контейнеров в ${dbPath}\n` +
          WARMUP_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      expect(
        plainRows(
          db.query(
            "SELECT endpoint_id, container_id FROM portainer_containers " +
              "ORDER BY endpoint_id",
          ),
        ),
      ).toStrictEqual([
        { endpoint_id: 1, container_id: "c1" },
        { endpoint_id: 2, container_id: "c2" },
      ]);
    } finally {
      await stop();
    }
  });
});

it("--dry-run: не удаляет ничего, даже когда endpoint стал down", async () => {
  await withTempDb(async (dbPath) => {
    let statusOfOne = 1;
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect((await invokeInit([], io)).code).toBe(0);

      statusOfOne = 2;
      const dryRun = await invokeInit(["--dry-run"], io);
      expect(dryRun.code).toBe(0);
      expect(dryRun.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          "mpu init: endpoint 1 (prod): down — пропущен\n",
      );

      using db = openCacheDb(dbPath);
      expect(
        plainRows(
          db.query(
            "SELECT endpoint_id, container_id FROM portainer_containers " +
              "ORDER BY endpoint_id",
          ),
        ),
        "--dry-run обязан оставить кэш нетронутым, включая записи down-endpoint'а",
      ).toStrictEqual([
        { endpoint_id: 1, container_id: "c1" },
        { endpoint_id: 2, container_id: "c2" },
      ]);
    } finally {
      await stop();
    }
  });
});

it("секреты: API-ключ не появляется ни в stdout, ни в stderr", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await serveFetch((req) => {
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
      expect(outcome.stdout.includes(API_KEY)).toBe(false);
      expect(outcome.stderr.includes(API_KEY)).toBe(false);
    } finally {
      await stop();
    }
  });
});

it("happy path со всеми шагами: блоки stderr идут в порядке 1..5", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await fakeStand();
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          STAND_WARMUP_LINES,
      );
      // Шаг 5 сказал, чего не сделал: терминала у прогона нет, и вход
      // пропущен — молчаливого пропуска у него не бывает
      // (`telegram-login.md`, инвариант 3). Прежде здесь ждали тишины:
      // подпроцесс возвращал ноль и печатал сам, мимо нашего вывода.
      expect(outcome.stderr).toContain("# telegram: пропущено (нет TTY;");

      using db = openCacheDb(dbPath);
      const count = (table: string) =>
        Number(db.query(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
      expect(count("loki_hosts")).toBe(2);
      expect(count("loki_services_by_host")).toBe(2);
      expect(count("kaiten_spaces")).toBe(1);
      expect(count("kaiten_boards")).toBe(2);
      expect(count("kaiten_lanes")).toBe(3);
      expect(count("kaiten_columns")).toBe(3);
      expect(count("kaiten_roles")).toBe(2);
    } finally {
      await stop();
    }
  });
});

it("порядок блоков не зависит от порядка завершения шагов", async () => {
  await withTempDb(async (dbPath) => {
    // Loki отвечает строго ПОСЛЕ того, как Kaiten дочитан: шаг 3
    // завершается последним, но его блок обязан стоять перед блоком 4.
    const rolesServed = Promise.withResolvers<void>();
    const { baseUrl, stop } = await fakeStand((url) => {
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
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          STAND_WARMUP_LINES,
      );
    } finally {
      await stop();
    }
  });
});

it("шаги 2–4 конкурентны: три запроса пришли раньше первого ответа", async () => {
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
    const { baseUrl, stop } = await fakeStand((url) => {
      const first = url.pathname === "/api/endpoints/1/docker/containers/json";
      if (
        !first &&
        url.pathname !== "/loki/api/v1/series" &&
        url.pathname !== "/api/latest/spaces"
      ) {
        return undefined;
      }
      return gate().then(() => undefined);
    });
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      expect(outcome.code).toBe(0);
      expect(arrivals >= 3, `запросов пришло ${arrivals}`).toBe(true);
    } finally {
      await stop();
    }
  });
});

it("--dry-run: шаги 3–5 не выполняются вовсе", async () => {
  await withTempDb(async (dbPath) => {
    const touched: string[] = [];
    const { baseUrl, stop } = await fakeStand((url) => {
      if (
        url.pathname !== "/api/endpoints" &&
        !url.pathname.startsWith("/api/endpoints/1/")
      ) {
        touched.push(url.pathname);
      }
      return undefined;
    });
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit(["--dry-run"], io);
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n`,
      );
      expect(touched, "прогревы ходили в сеть при --dry-run").toStrictEqual([]);
      // Шаг 5 при `--dry-run` не идёт вовсе: его строки в выводе нет.
      expect(
        outcome.stderr.includes("# telegram"),
        "шаг 5 запускался при --dry-run",
      ).toBe(false);
    } finally {
      await stop();
    }
  });
});

describe("шаг 5: причина пропуска — от самого входа, exit 0", () => {
  // Прежде здесь стояли причины подпроцесса — «код возврата 3» и
  // «прежняя реализация не найдена». С порции 95 подпроцесса нет, и
  // ломаться на запуске нечему: причины теперь те, что называет сам
  // вход (`telegram-login.md`). Проверяется главное свойство шага:
  // какой бы ни был исход, код `init` он не меняет.
  const cases: readonly (readonly [string, Partial<CommandIo>, string])[] = [
    [
      "нет терминала",
      {},
      "# telegram: пропущено (нет TTY; заполни TELEGRAM_API_ID/HASH " +
        "в .env вручную)\n",
    ],
  ];
  for (const [name, override, expected] of cases) {
    it(name, async () => {
      await withTempDb(async (dbPath) => {
        const { baseUrl, stop } = await fakeStand();
        try {
          const io = makeIo(dbPath, {
            envFile: standEnv(baseUrl),
            ...override,
          });
          const outcome = await invokeInit([], io);
          expect(outcome.code, "шаг 5 изменил код init").toBe(0);
          expect(outcome.stderr).toContain(expected);
        } finally {
          await stop();
        }
      });
    });
  }
});

it("шаг 5 начинается строго после шагов 2–4", async () => {
  await withTempDb(async (dbPath) => {
    const order: string[] = [];
    const { baseUrl, stop } = await fakeStand((url) => {
      order.push(url.pathname);
      return undefined;
    });
    try {
      // Шаг 5 больше не подпроцесс, и его момент виден по строке хода,
      // а не по запуску: вход печатает её сам, и печатает последней.
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      expect(outcome.code).toBe(0);
      const lines = outcome.stderr.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toContain("# telegram: пропущено");
      // А шаги 2–4 к этому моменту уже сходили в сеть.
      expect(order.length > 0, "шаги 2–4 не ходили в сеть").toBe(true);
    } finally {
      await stop();
    }
  });
});

it("пропуск одной доски Kaiten: строка и scoped-запись остальных", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await fakeStand((url) => {
      if (boardOf(url.pathname, "lanes") === "502") {
        return new Response("boom", { status: 500 });
      }
      return undefined;
    });
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: 2 hosts, 2 (host, service) пар\n" +
          "# kaiten: доска 502: пропущена " +
          "(kaiten GET /boards/502/lanes -> 500: boom)\n" +
          "# kaiten: 1 spaces, 2 boards, 2 lanes, 3 columns, 2 roles\n" +
          TELEGRAM_SKIPPED,
      );

      // Собранное по здоровой доске записано, обход не оборван.
      using db = openCacheDb(dbPath);
      expect(
        plainRows(db.query("SELECT id FROM kaiten_lanes ORDER BY id")),
      ).toStrictEqual([{ id: 9001 }, { id: 9002 }]);
      expect(
        Number(db.query("SELECT COUNT(*) AS n FROM kaiten_columns")[0].n),
      ).toBe(3);
    } finally {
      await stop();
    }
  });
});

it("часть 2 Kaiten упала целиком: счётчик в сводке — «?»", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await fakeStand((url) =>
      boardOf(url.pathname, "lanes") === undefined
        ? undefined
        : new Response("boom", { status: 500 }),
    );
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      expect(outcome.code).toBe(0);
      // Ноль от «?» отличается: пустой справочник — не то же самое, что
      // справочник, о котором ничего не известно (init.md, шаг 4).
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: 2 hosts, 2 (host, service) пар\n" +
          "# kaiten: доска 501: пропущена " +
          "(kaiten GET /boards/501/lanes -> 500: boom)\n" +
          "# kaiten: доска 502: пропущена " +
          "(kaiten GET /boards/502/lanes -> 500: boom)\n" +
          "# kaiten: 1 spaces, 2 boards, ? lanes, 3 columns, 2 roles\n" +
          TELEGRAM_SKIPPED,
      );

      // Упавшая целиком часть кэш дорожек не трогает вовсе.
      using db = openCacheDb(dbPath);
      expect(
        Number(db.query("SELECT COUNT(*) AS n FROM kaiten_lanes")[0].n),
      ).toBe(0);
    } finally {
      await stop();
    }
  });
});

it("прогрев Loki упал: строка пропуска, остальные шаги отработали", async () => {
  await withTempDb(async (dbPath) => {
    const { baseUrl, stop } = await fakeStand((url) =>
      url.pathname === "/loki/api/v1/series"
        ? new Response("nope", { status: 503 })
        : undefined,
    );
    try {
      const io = makeIo(dbPath, { envFile: standEnv(baseUrl) });
      const outcome = await invokeInit([], io);
      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toStrictEqual(
        `# bootstrap: схема в ${dbPath} готова\n` +
          `# записано 1 контейнеров в ${dbPath}\n` +
          "# loki: пропущено (HTTP 503)\n" +
          "# kaiten: 1 spaces, 2 boards, 3 lanes, 3 columns, 2 roles\n" +
          TELEGRAM_SKIPPED,
      );

      using db = openCacheDb(dbPath);
      expect(
        Number(db.query("SELECT COUNT(*) AS n FROM loki_hosts")[0].n),
        "упавший прогрев не должен трогать кэш Loki",
      ).toBe(0);
    } finally {
      await stop();
    }
  });
});

describe("URL Portainer без схемы — ошибка конфигурации, exit 2", () => {
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    [
      "флагом --portainer",
      ["--portainer", "portainer.example.com"],
      "portainer.example.com",
    ],
    ["ключом PORTAINER_URL", [], "10.0.0.7:9443"],
  ];
  for (const [name, argv, value] of cases) {
    it(name, async () => {
      await withTempDb(async (dbPath) => {
        const io = makeIo(dbPath, {
          envFile: envFileFake({
            PORTAINER_API_KEY: API_KEY,
            PORTAINER_URL: value,
          }),
        });
        const outcome = await invokeInit(argv, io);
        expect(outcome.code).toBe(2);
        expect(outcome.stderr).toStrictEqual(
          `# bootstrap: схема в ${dbPath} готова\n` +
            `mpu init: некорректный URL Portainer: '${value}' — ` +
            "нужна схема http:// или https://\n",
        );
      });
    });
  }
});
