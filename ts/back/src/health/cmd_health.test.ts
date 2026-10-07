/**
 * Команда `mpu health` (`docs/specs/health.md`). Живой фермы в тестах
 * нет: список контейнеров — синтетическая фикстура канала, логи —
 * подставные. Наблюдаемое — классификация, состав блоков, код выхода и
 * запрос логов.
 */

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempCache } from "../testing/cache.ts";
import { rejected } from "@mpu/testing/thrown";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import type { ContainerLogsQuery, PortainerContainer } from "@mpu/portainer";
import { PortainerError } from "@mpu/portainer";
import { makeFakeIo } from "../testing/mod.ts";
import { healthCommand } from "./cmd_health.ts";
import {
  type HealthArgs,
  type HealthIo,
  type HealthOptions,
  runHealth,
} from "./run.ts";

const ENV: Readonly<Record<string, string>> = {
  PORTAINER_API_KEY: "k",
  sl_1_portainer: "https://portainer.example/4",
};

/** Момент отсчёта `--since`: фиксирован, иначе окно плыло бы. */
const NOW = 1_700_000_000;

function args(overrides: Partial<HealthArgs> = {}): HealthArgs {
  return {
    selector: "sl-1",
    tail: 30,
    since: undefined,
    all: false,
    ...overrides,
  };
}

function harness(db?: CacheDb) {
  const io = makeFakeIo({
    envFile: {
      get: (name) => ENV[name],
      values: () => ({ ...ENV }),
      require: (name) => ENV[name] ?? "",
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
    },
    openCacheDb: () => {
      if (db === undefined) throw new Error("кэш-БД открываться не должна");
      return { ...db, [Symbol.dispose]: () => {} };
    },
  });
  return io as HealthIo;
}

/** Кэш-БД без строк: сервер резолвится коротким циклом `sl-N`. */
async function withCache(body: (db: CacheDb) => Promise<void>): Promise<void> {
  const { db, close } = await openTempCache((db) => db.bootstrap());
  try {
    await body(db);
  } finally {
    await close();
  }
}

/** Синтетический ответ `containers/json` — фикстура канала. */
async function liveContainers(): Promise<readonly PortainerContainer[]> {
  const raw = JSON.parse(
    await readFile(
      new URL("./testdata/health/live-containers-json.json", import.meta.url),
      "utf8",
    ),
  ) as readonly {
    Id: string;
    Names: string[];
    Image: string;
    State: string;
    Status: string;
  }[];
  return raw.map((c) => ({
    id: c.Id,
    names: c.Names,
    state: c.State,
    status: c.Status,
    image: c.Image,
  }));
}

/** Кадр stderr мультиплекса Docker. */
function stderrFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = 2;
  new DataView(frame.buffer).setUint32(4, payload.length, false);
  frame.set(payload, 8);
  return frame;
}

/** Кадр stdout: его в tail печатать нельзя. */
function stdoutFrame(text: string): Uint8Array {
  const frame = stderrFrame(text);
  frame[0] = 1;
  return frame;
}

function options(overrides: Partial<HealthOptions> = {}): HealthOptions {
  return {
    now: () => NOW,
    listLive: async () => await liveContainers(),
    fetchLogs: () => Promise.resolve(new Uint8Array()),
    ...overrides,
  };
}

describe("классификация фикстуры канала: блоки и код выхода", () => {
  let db: CacheDb;
  let close: () => Promise<void>;
  let result: Awaited<ReturnType<typeof runHealth>>;
  beforeAll(async () => {
    ({ db, close } = await openTempCache((db) => db.bootstrap()));
    result = await runHealth(args(), harness(db), options());
  });
  afterAll(() => close());

  it("mp-строки: служебный контейнер ноды не в счёт", () => {
    // `cadvisor` под правило `sl-`/`wb-` не подходит и в таблицу не
    // идёт (спека, п. 1).
    expect(result.mpCount).toBe(3);
    expect(result.rows.map((row) => row.name)).toStrictEqual([
      "mp-sl-1-cli",
      "mp-sl-1-migrations",
      "mp-wb-loader-app",
    ]);
  });

  it("штатный one-shot не считается проблемой", () => {
    expect(result.oneShot.map((row) => row.name)).toStrictEqual([
      "mp-sl-1-migrations",
    ]);
  });

  it("демон с ненулевым кодом — предупреждение и exit 1", () => {
    expect(result.notRunning.map((row) => row.name)).toStrictEqual([
      "mp-wb-loader-app",
    ]);
    expect(result.exitCode).toBe(1);
    expect(healthCommand.textExitCode(result)).toBe(1);
  });

  it("вывод: заголовок, таблица, оба блока", () => {
    const text = healthCommand.renderResult(result, ["sl-1"]);
    expect(text).toContain("=== sl-1: 3 mp-* containers ===\n");
    expect(text).toContain(
      "NAME                STATE    STATUS\n" +
        "mp-sl-1-cli         running  Up 3 days\n",
    );
    expect(text).toContain(
      "✓ One-shot containers (completed normally):\n" +
        "  mp-sl-1-migrations: Exited (0) 3 days ago\n",
    );
    expect(text).toContain(
      "⚠️  Containers not in 'running' state:\n" +
        "  mp-wb-loader-app: state=exited status=Exited (137) 2 hours ago\n",
    );
  });
});

describe("tail: только stderr, только у лоадер-подобных демонов", () => {
  let db: CacheDb;
  let close: () => Promise<void>;
  const asked: { name: string; query: ContainerLogsQuery }[] = [];
  let result: Awaited<ReturnType<typeof runHealth>>;
  beforeAll(async () => {
    ({ db, close } = await openTempCache((db) => db.bootstrap()));
    result = await runHealth(
      args({ tail: 7, since: "2h" }),
      harness(db),
      options({
        fetchLogs: (_access, _endpoint, name, query) => {
          asked.push({ name, query });
          return Promise.resolve(
            new Uint8Array([
              ...stdoutFrame("рабочий шум\n"),
              ...stderrFrame("ошибка\n"),
            ]),
          );
        },
      }),
    );
  });
  afterAll(() => close());

  it("таргет один: loader, не cli и не migrations", () => {
    expect(asked.map((call) => call.name)).toStrictEqual(["mp-wb-loader-app"]);
  });

  it("запрос лога — по спеке транспорта", () => {
    expect(asked[0].query).toStrictEqual({
      stdout: false,
      stderr: true,
      tail: 7,
      timestamps: true,
      sinceUnix: NOW - 7_200,
    });
  });

  it("в вывод идёт stderr, stdout отброшен", () => {
    const text = healthCommand.renderResult(result, ["sl-1"]);
    expect(text).toContain(
      "=== tail --7 (stderr) for 1 container(s) ===\n" +
        "--- mp-wb-loader-app (stderr, tail=7) ---\n" +
        "ошибка\n",
    );
    expect(text.includes("рабочий шум")).toBe(false);
  });
});

describe("tail: пустое окно, сбой логов и TTY-контейнер", () => {
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openTempCache((db) => db.bootstrap()));
  });
  afterAll(() => close());

  it("пустой stderr — своя строка", async () => {
    const result = await runHealth(args(), harness(db), options());
    expect(healthCommand.renderResult(result, ["sl-1"])).toContain(
      "--- mp-wb-loader-app (stderr, tail=30) ---\n  (no stderr in window)\n",
    );
  });

  it("сбой логов не меняет код выхода", async () => {
    const result = await runHealth(
      args(),
      harness(db),
      options({
        fetchLogs: () => Promise.reject(new PortainerError("HTTP 500")),
      }),
    );
    expect(healthCommand.renderResult(result, ["sl-1"])).toContain(
      "  (logs error: HTTP 500)\n",
    );
    // Код выхода определяется блоком предупреждений, а не логами.
    expect(result.exitCode).toBe(1);
  });

  it("TTY-контейнер: весь лог считается stdout", async () => {
    const result = await runHealth(
      args(),
      harness(db),
      options({
        // Первый байт вне {0,1,2} — фрейминга нет вовсе.
        fetchLogs: () =>
          Promise.resolve(new TextEncoder().encode("сырой лог\n")),
      }),
    );
    expect(healthCommand.renderResult(result, ["sl-1"])).toContain(
      "  (no stderr in window)\n",
    );
  });
});

it("--all берёт логи у всех демонов, но не у one-shot'ов", async () => {
  await withCache(async (db) => {
    const asked: string[] = [];
    await runHealth(
      args({ all: true }),
      harness(db),
      options({
        fetchLogs: (_a, _e, name) => {
          asked.push(name);
          return Promise.resolve(new Uint8Array());
        },
      }),
    );
    // `migrations` — one-shot по имени, в демоны не входит независимо
    // от состояния (спека, п. 5).
    expect(asked).toStrictEqual(["mp-sl-1-cli", "mp-wb-loader-app"]);
  });
});

describe("--since: форматы и валидация до сети", () => {
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openTempCache((db) => db.bootstrap()));
  });
  afterAll(() => close());

  it("строка из цифр — буквальный unix-ts", async () => {
    const asked: ContainerLogsQuery[] = [];
    await runHealth(
      args({ since: "90" }),
      harness(db),
      options({
        fetchLogs: (_a, _e, _n, query) => {
          asked.push(query);
          return Promise.resolve(new Uint8Array());
        },
      }),
    );
    expect(asked[0].sinceUnix).toBe(90);
  });

  it("иной формат — ошибка ввода до сети", async () => {
    const err = await rejected(
      () =>
        runHealth(
          args({ since: "вчера" }),
          harness(db),
          options({
            listLive: () => {
              throw new Error("сети быть не должно");
            },
          }),
        ),
      UsageError,
    );
    expect(formatCommandError("health", err)).toStrictEqual(
      "mpu health: --since: ожидается <число>{s|m|h|d} или unix-ts," +
        " получено 'вчера'",
    );
  });
});

describe("отказы конфигурации и сети", () => {
  it("нет ключа Portainer — эталон канала", async () => {
    await withCache(async (db) => {
      const io = makeFakeIo({
        envFile: {
          get: () => undefined,
          values: () => ({}),
          require: () => "",
          set: () => Promise.reject(new Error("не ожидается")),
        },
        openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
      }) as HealthIo;
      const err = await rejected(
        () => runHealth(args(), io, options()),
        UsageError,
      );
      expect(`${formatCommandError("health", err)}\n`).toStrictEqual(
        await readFile(
          new URL(
            "./testdata/health/err-no-api-key-stderr.txt",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    });
  });

  it("список не получен — доменная ошибка, exit 1", async () => {
    await withCache(async (db) => {
      const err = await rejected(
        () =>
          runHealth(
            args(),
            harness(db),
            options({
              listLive: () => Promise.reject(new PortainerError("HTTP 502")),
            }),
          ),
        DomainError,
      );
      expect(formatCommandError("health", err)).toBe(
        "mpu health: portainer error: HTTP 502",
      );
    });
  });
});

describe("объявление команды: политика и предел описания", () => {
  it("читающая команда — класс ro", () => {
    expect(healthCommand.path).toStrictEqual(["health"]);
    expect(healthCommand.policy).toBe("ro");
  });

  it("описание тула укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${healthCommand.summary}\n\n${healthCommand.help}`,
    ).length;
    expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
  });
});

describe("one-shot с ненулевым кодом — предупреждение и exit 1", () => {
  const oneShot = (status: string): readonly PortainerContainer[] => [
    {
      id: "a",
      names: ["/mp-sl-1-migrations"],
      state: "exited",
      status,
      image: "registry.example/app:1.2.3",
    },
  ];

  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openTempCache((db) => db.bootstrap()));
  });
  afterAll(() => close());

  it("Exited (0) — штатное завершение, exit 0", async () => {
    const result = await runHealth(
      args(),
      harness(db),
      options({ listLive: () => Promise.resolve(oneShot("Exited (0) ago")) }),
    );
    expect(result.oneShot.length).toBe(1);
    expect(result.notRunning).toStrictEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("Exited (1) — уже проблема, exit 1", async () => {
    // Ключевое слово в имени само по себе индульгенции не даёт:
    // штатным считается только нулевой код (спека, «Граничные
    // случаи»).
    const result = await runHealth(
      args(),
      harness(db),
      options({ listLive: () => Promise.resolve(oneShot("Exited (1) ago")) }),
    );
    expect(result.oneShot).toStrictEqual([]);
    expect(result.notRunning.map((row) => row.name)).toStrictEqual([
      "mp-sl-1-migrations",
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("restarting — тоже проблема", async () => {
    const result = await runHealth(
      args(),
      harness(db),
      options({
        listLive: () =>
          Promise.resolve([
            {
              id: "b",
              names: ["/mp-sl-1-cli"],
              state: "restarting",
              status: "Restarting (1) 5 seconds ago",
              image: "registry.example/app:1.2.3",
            },
          ]),
      }),
    );
    expect(result.exitCode).toBe(1);
  });
});

it("mp-строка: префикс `mp-` необязателен", async () => {
  await withCache(async (db) => {
    const result = await runHealth(
      args(),
      harness(db),
      options({
        listLive: () =>
          Promise.resolve([
            {
              id: "a",
              names: ["/sl-2-wb-loader"],
              state: "exited",
              status: "Exited (137) 1 hour ago",
              image: "образ",
            },
            {
              id: "b",
              names: ["/mp-sl-2-i-app"],
              state: "running",
              status: "Up 1 hour",
              image: "образ",
            },
            {
              id: "c",
              names: ["/portainer_agent"],
              state: "running",
              status: "Up 1 hour",
              image: "образ",
            },
          ]),
      }),
    );
    // Обе формы живут на ферме одновременно: без второй таблица теряет
    // большинство контейнеров, а код выхода перестаёт что-либо значить
    // (спека, п. 1). Служебный контейнер ноды под правило не подходит.
    expect(result.mpCount).toBe(2);
    expect(result.rows.map((row) => row.name)).toStrictEqual([
      "mp-sl-2-i-app",
      "sl-2-wb-loader",
    ]);
    expect(result.notRunning.map((row) => row.name)).toStrictEqual([
      "sl-2-wb-loader",
    ]);
    expect(result.exitCode).toBe(1);
  });
});

describe("непокрытые спекой ветви: нет mp-строк, нет таргетов, нет таргета Portainer", () => {
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openTempCache((db) => db.bootstrap()));
  });
  afterAll(() => close());

  it("нуль mp-строк — таблица печатает всё, что есть", async () => {
    // Диагностической команде это полезнее пустой таблицы, хотя
    // заголовок и сообщает `0 mp-* containers` (отклонение
    // `preserve` спеки).
    const result = await runHealth(
      args(),
      harness(db),
      options({
        listLive: () =>
          Promise.resolve([
            {
              id: "a",
              names: ["/cadvisor"],
              state: "running",
              status: "Up 3 days",
              image: "образ",
            },
          ]),
      }),
    );
    expect(result.mpCount).toBe(0);
    expect(result.rows.map((row) => row.name)).toStrictEqual(["cadvisor"]);
    const text = healthCommand.renderResult(result, ["sl-1"]);
    expect(text).toContain("=== sl-1: 0 mp-* containers ===\n");
    expect(text).toContain("cadvisor  running  Up 3 days\n");
  });

  it("нет лоадер-подобных демонов — tail-блока нет вовсе", async () => {
    const result = await runHealth(
      args(),
      harness(db),
      options({
        listLive: () =>
          Promise.resolve([
            {
              id: "a",
              names: ["/mp-sl-1-cli"],
              state: "running",
              status: "Up 3 days",
              image: "образ",
            },
          ]),
        fetchLogs: () => {
          throw new Error("логов спрашивать не у кого");
        },
      }),
    );
    expect(result.tails).toStrictEqual([]);
    const text = healthCommand.renderResult(result, ["sl-1"]);
    expect(text.includes("=== tail")).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("сервер без Portainer-таргета — тот же текст, что у ps", async () => {
    const io = makeFakeIo({
      envFile: {
        get: (name) => (name === "PORTAINER_API_KEY" ? "k" : undefined),
        values: () => ({ PORTAINER_API_KEY: "k" }),
        require: () => "",
        set: () => Promise.reject(new Error("не ожидается")),
      },
      openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    }) as HealthIo;
    const err = await rejected(
      () => runHealth(args({ selector: "sl-9" }), io, options()),
      UsageError,
    );
    expect(err.message).toStrictEqual(
      "для sl-9 не найден portainer-target (SQLite после `mpu init`" +
        " или sl_9_portainer в ~/.config/mpu/.env)",
    );
  });
});

describe("limit: целое больше нуля, проверка до сети", () => {
  const cases: readonly number[] = [0, -3, 2.5];
  for (const tail of cases) {
    it(`--tail ${tail}`, async () => {
      await withCache(async (db) => {
        const err = await rejected(
          () =>
            runHealth(
              args({ tail }),
              harness(db),
              options({
                listLive: () => {
                  throw new Error("сети быть не должно");
                },
              }),
            ),
          UsageError,
        );
        expect(err.message).toStrictEqual(
          `limit: ожидается целое > 0, получено '${tail}'`,
        );
      });
    });
  }
});
