/**
 * Команда `mpu health` (`docs/specs/health.md`). Живой фермы в тестах
 * нет: список контейнеров — синтетическая фикстура канала, логи —
 * подставные. Наблюдаемое — классификация, состав блоков, код выхода и
 * запрос логов.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import type {
  ContainerLogsQuery,
  PortainerContainer,
} from "../portainer/mod.ts";
import { PortainerError } from "../portainer/mod.ts";
import { openCacheDb } from "../store/mod.ts";
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
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Синтетический ответ `containers/json` — фикстура канала. */
async function liveContainers(): Promise<readonly PortainerContainer[]> {
  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("./testdata/health/live-containers-json.json", import.meta.url),
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

Deno.test("классификация фикстуры канала: блоки и код выхода", async (t) => {
  await withCache(async (db) => {
    const result = await runHealth(args(), harness(db), options());

    await t.step("mp-строки: служебный контейнер ноды не в счёт", () => {
      // `cadvisor` под правило `sl-`/`wb-` не подходит и в таблицу не
      // идёт (спека, п. 1).
      assertEquals(result.mpCount, 3);
      assertEquals(result.rows.map((row) => row.name), [
        "mp-sl-1-cli",
        "mp-sl-1-migrations",
        "mp-wb-loader-app",
      ]);
    });

    await t.step("штатный one-shot не считается проблемой", () => {
      assertEquals(result.oneShot.map((row) => row.name), [
        "mp-sl-1-migrations",
      ]);
    });

    await t.step("демон с ненулевым кодом — предупреждение и exit 1", () => {
      assertEquals(result.notRunning.map((row) => row.name), [
        "mp-wb-loader-app",
      ]);
      assertEquals(result.exitCode, 1);
      assertEquals(healthCommand.textExitCode(result), 1);
    });

    await t.step("вывод: заголовок, таблица, оба блока", () => {
      const text = healthCommand.renderResult(result, ["sl-1"]);
      assertStringIncludes(text, "=== sl-1: 3 mp-* containers ===\n");
      assertStringIncludes(
        text,
        "NAME                STATE    STATUS\n" +
          "mp-sl-1-cli         running  Up 3 days\n",
      );
      assertStringIncludes(
        text,
        "✓ One-shot containers (completed normally):\n" +
          "  mp-sl-1-migrations: Exited (0) 3 days ago\n",
      );
      assertStringIncludes(
        text,
        "⚠️  Containers not in 'running' state:\n" +
          "  mp-wb-loader-app: state=exited status=Exited (137) 2 hours ago\n",
      );
    });
  });
});

Deno.test("tail: только stderr, только у лоадер-подобных демонов", async (t) => {
  await withCache(async (db) => {
    const asked: { name: string; query: ContainerLogsQuery }[] = [];
    const result = await runHealth(
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

    await t.step("таргет один: loader, не cli и не migrations", () => {
      assertEquals(asked.map((call) => call.name), ["mp-wb-loader-app"]);
    });

    await t.step("запрос лога — по спеке транспорта", () => {
      assertEquals(asked[0].query, {
        stdout: false,
        stderr: true,
        tail: 7,
        timestamps: true,
        sinceUnix: NOW - 7_200,
      });
    });

    await t.step("в вывод идёт stderr, stdout отброшен", () => {
      const text = healthCommand.renderResult(result, ["sl-1"]);
      assertStringIncludes(
        text,
        "=== tail --7 (stderr) for 1 container(s) ===\n" +
          "--- mp-wb-loader-app (stderr, tail=7) ---\n" +
          "ошибка\n",
      );
      assertEquals(text.includes("рабочий шум"), false);
    });
  });
});

Deno.test("tail: пустое окно, сбой логов и TTY-контейнер", async (t) => {
  await withCache(async (db) => {
    await t.step("пустой stderr — своя строка", async () => {
      const result = await runHealth(args(), harness(db), options());
      assertStringIncludes(
        healthCommand.renderResult(result, ["sl-1"]),
        "--- mp-wb-loader-app (stderr, tail=30) ---\n  (no stderr in window)\n",
      );
    });

    await t.step("сбой логов не меняет код выхода", async () => {
      const result = await runHealth(
        args(),
        harness(db),
        options({
          fetchLogs: () => Promise.reject(new PortainerError("HTTP 500")),
        }),
      );
      assertStringIncludes(
        healthCommand.renderResult(result, ["sl-1"]),
        "  (logs error: HTTP 500)\n",
      );
      // Код выхода определяется блоком предупреждений, а не логами.
      assertEquals(result.exitCode, 1);
    });

    await t.step("TTY-контейнер: весь лог считается stdout", async () => {
      const result = await runHealth(
        args(),
        harness(db),
        options({
          // Первый байт вне {0,1,2} — фрейминга нет вовсе.
          fetchLogs: () =>
            Promise.resolve(new TextEncoder().encode("сырой лог\n")),
        }),
      );
      assertStringIncludes(
        healthCommand.renderResult(result, ["sl-1"]),
        "  (no stderr in window)\n",
      );
    });
  });
});

Deno.test("--all берёт логи у всех демонов, но не у one-shot'ов", async () => {
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
    assertEquals(asked, ["mp-sl-1-cli", "mp-wb-loader-app"]);
  });
});

Deno.test("--since: форматы и валидация до сети", async (t) => {
  await withCache(async (db) => {
    await t.step("строка из цифр — буквальный unix-ts", async () => {
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
      assertEquals(asked[0].sinceUnix, 90);
    });

    await t.step("иной формат — ошибка ввода до сети", async () => {
      const err = await assertRejects(
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
      assertEquals(
        formatCommandError("health", err),
        "mpu health: --since: ожидается <число>{s|m|h|d} или unix-ts," +
          " получено 'вчера'",
      );
    });
  });
});

Deno.test("отказы конфигурации и сети", async (t) => {
  await t.step("нет ключа Portainer — эталон канала", async () => {
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
      const err = await assertRejects(
        () => runHealth(args(), io, options()),
        UsageError,
      );
      assertEquals(
        `${formatCommandError("health", err)}\n`,
        await Deno.readTextFile(
          new URL(
            "./testdata/health/err-no-api-key-stderr.txt",
            import.meta.url,
          ),
        ),
      );
    });
  });

  await t.step("список не получен — доменная ошибка, exit 1", async () => {
    await withCache(async (db) => {
      const err = await assertRejects(
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
      assertEquals(
        formatCommandError("health", err),
        "mpu health: portainer error: HTTP 502",
      );
    });
  });
});

Deno.test("объявление команды: политика и предел описания", async (t) => {
  await t.step("читающая команда — класс ro", () => {
    assertEquals(healthCommand.path, ["health"]);
    assertEquals(healthCommand.policy, "ro");
  });

  await t.step("описание тула укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${healthCommand.summary}\n\n${healthCommand.help}`,
    ).length;
    assertEquals(bytes < 2048, true, `описание не влезло: ${bytes} байт`);
  });
});

Deno.test("one-shot с ненулевым кодом — предупреждение и exit 1", async (t) => {
  const oneShot = (status: string): readonly PortainerContainer[] => [
    {
      id: "a",
      names: ["/mp-sl-1-migrations"],
      state: "exited",
      status,
      image: "registry.example/app:1.2.3",
    },
  ];

  await withCache(async (db) => {
    await t.step("Exited (0) — штатное завершение, exit 0", async () => {
      const result = await runHealth(
        args(),
        harness(db),
        options({ listLive: () => Promise.resolve(oneShot("Exited (0) ago")) }),
      );
      assertEquals(result.oneShot.length, 1);
      assertEquals(result.notRunning, []);
      assertEquals(result.exitCode, 0);
    });

    await t.step("Exited (1) — уже проблема, exit 1", async () => {
      // Ключевое слово в имени само по себе индульгенции не даёт:
      // штатным считается только нулевой код (спека, «Граничные
      // случаи»).
      const result = await runHealth(
        args(),
        harness(db),
        options({ listLive: () => Promise.resolve(oneShot("Exited (1) ago")) }),
      );
      assertEquals(result.oneShot, []);
      assertEquals(result.notRunning.map((row) => row.name), [
        "mp-sl-1-migrations",
      ]);
      assertEquals(result.exitCode, 1);
    });

    await t.step("restarting — тоже проблема", async () => {
      const result = await runHealth(
        args(),
        harness(db),
        options({
          listLive: () =>
            Promise.resolve([{
              id: "b",
              names: ["/mp-sl-1-cli"],
              state: "restarting",
              status: "Restarting (1) 5 seconds ago",
              image: "registry.example/app:1.2.3",
            }]),
        }),
      );
      assertEquals(result.exitCode, 1);
    });
  });
});

Deno.test("mp-строка: префикс `mp-` необязателен", async () => {
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
    assertEquals(result.mpCount, 2);
    assertEquals(result.rows.map((row) => row.name), [
      "mp-sl-2-i-app",
      "sl-2-wb-loader",
    ]);
    assertEquals(result.notRunning.map((row) => row.name), ["sl-2-wb-loader"]);
    assertEquals(result.exitCode, 1);
  });
});

Deno.test("непокрытые спекой ветви: нет mp-строк, нет таргетов, нет таргета Portainer", async (t) => {
  await withCache(async (db) => {
    await t.step("нуль mp-строк — таблица печатает всё, что есть", async () => {
      // Диагностической команде это полезнее пустой таблицы, хотя
      // заголовок и сообщает `0 mp-* containers` (отклонение
      // `preserve` спеки).
      const result = await runHealth(
        args(),
        harness(db),
        options({
          listLive: () =>
            Promise.resolve([{
              id: "a",
              names: ["/cadvisor"],
              state: "running",
              status: "Up 3 days",
              image: "образ",
            }]),
        }),
      );
      assertEquals(result.mpCount, 0);
      assertEquals(result.rows.map((row) => row.name), ["cadvisor"]);
      const text = healthCommand.renderResult(result, ["sl-1"]);
      assertStringIncludes(text, "=== sl-1: 0 mp-* containers ===\n");
      assertStringIncludes(text, "cadvisor  running  Up 3 days\n");
    });

    await t.step(
      "нет лоадер-подобных демонов — tail-блока нет вовсе",
      async () => {
        const result = await runHealth(
          args(),
          harness(db),
          options({
            listLive: () =>
              Promise.resolve([{
                id: "a",
                names: ["/mp-sl-1-cli"],
                state: "running",
                status: "Up 3 days",
                image: "образ",
              }]),
            fetchLogs: () => {
              throw new Error("логов спрашивать не у кого");
            },
          }),
        );
        assertEquals(result.tails, []);
        const text = healthCommand.renderResult(result, ["sl-1"]);
        assertEquals(text.includes("=== tail"), false);
        assertEquals(result.exitCode, 0);
      },
    );

    await t.step(
      "сервер без Portainer-таргета — тот же текст, что у ps",
      async () => {
        const io = makeFakeIo({
          envFile: {
            get: (name) => name === "PORTAINER_API_KEY" ? "k" : undefined,
            values: () => ({ PORTAINER_API_KEY: "k" }),
            require: () => "",
            set: () => Promise.reject(new Error("не ожидается")),
          },
          openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
        }) as HealthIo;
        const err = await assertRejects(
          () => runHealth(args({ selector: "sl-9" }), io, options()),
          UsageError,
        );
        assertEquals(
          err.message,
          "для sl-9 не найден portainer-target (SQLite после `mpu init`" +
            " или sl_9_portainer в ~/.config/mpu/.env)",
        );
      },
    );
  });
});

Deno.test("--tail: целое больше нуля, проверка до сети", async (t) => {
  const cases: readonly number[] = [0, -3, 2.5];
  for (const tail of cases) {
    await t.step(`--tail ${tail}`, async () => {
      await withCache(async (db) => {
        const err = await assertRejects(
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
        assertEquals(
          err.message,
          `--tail: ожидается целое > 0, получено '${tail}'`,
        );
      });
    });
  }
});
