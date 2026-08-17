/**
 * Команда `mpu ps` (`docs/specs/ps.md`). Кэш настоящий, во временном
 * каталоге; живой список — подставной, сети в тестах нет. Наблюдаемое —
 * эталоны канала, строки stderr и коды ошибок.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import type { PortainerAccess, PortainerContainer } from "../portainer/mod.ts";
import { PortainerError } from "../portainer/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { psCommand } from "./cmd_ps.ts";
import { type PsArgs, type PsIo, type PsOptions, runPs } from "./run.ts";

const ENV: Readonly<Record<string, string>> = {
  PORTAINER_API_KEY: "k",
  sl_1_portainer: "https://portainer.example/4",
};

/** Синтетический кэш эталонов: четыре строки, включая NULL-поля. */
const CACHE: readonly (readonly [
  string | null,
  string,
  string | null,
  string | null,
  number | null,
])[] = [
  ["stand-a", "mp-sl-1-cli", "running", "registry.example/app:1.2.3", 1],
  [
    "stand-a",
    "mp-sl-1-migrations",
    "exited",
    "registry.example/app:1.2.3",
    null,
  ],
  [
    "stand-a",
    "mp-wb-loader-app",
    "running",
    "registry.example/loader:4.5",
    null,
  ],
  [null, "mp_probe-underscore", null, null, null],
];

function args(overrides: Partial<PsArgs> = {}): PsArgs {
  return {
    selector: undefined,
    filter: undefined,
    json: false,
    tsv: false,
    ...overrides,
  };
}

function harness(db?: CacheDb) {
  const progress: string[] = [];
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
    progress: (line: string) => progress.push(line),
  });
  return { io: io as PsIo, progress };
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/ps/${name}`, import.meta.url),
  );
}

/** Кэш-БД во временном каталоге; `rows` пуст — таблица есть, строк нет. */
async function withCache(
  rows: typeof CACHE,
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    for (const [index, row] of rows.entries()) {
      db.execute(
        "INSERT INTO portainer_containers (portainer_url, endpoint_id," +
          " endpoint_name, container_id, container_name, server_number," +
          " state, image, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "https://portainer.example",
        1,
        row[0],
        `id-${index}`,
        row[1],
        row[4],
        row[2],
        row[3],
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Кэш-БД без схемы: таблицы контейнеров в ней нет вовсе. */
async function withoutTable(body: (db: CacheDb) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("кэш-режим: три формы вывода — эталоны канала", async (t) => {
  await withCache(CACHE, async (db) => {
    const { io, progress } = harness(db);
    const result = await runPs(args(), io);

    await t.step("таблица", async () => {
      assertEquals(
        psCommand.renderResult(result, []),
        await golden("cache-table-stdout.txt"),
      );
    });

    await t.step("строка про кэш — в stderr, первой", async () => {
      assertEquals(
        progress.map((line) => `${line}\n`).join(""),
        await golden("cache-table-stderr.txt"),
      );
    });

    await t.step("--json", async () => {
      assertEquals(
        psCommand.renderResult(result, ["--json"]),
        await golden("cache-json-stdout.txt"),
      );
    });

    await t.step("--tsv", async () => {
      assertEquals(
        psCommand.renderResult(result, ["--tsv"]),
        await golden("cache-tsv-stdout.txt"),
      );
    });
  });
});

Deno.test("кэш-режим: фильтр — буквальная подстрока", async (t) => {
  await withCache(CACHE, async (db) => {
    await t.step("совпадение — эталон канала", async () => {
      const { io } = harness(db);
      const result = await runPs(args({ filter: "wb-loader" }), io);
      assertEquals(
        psCommand.renderResult(result, []),
        await golden("cache-filter-stdout.txt"),
      );
    });

    await t.step("`_` не значит «любой символ»", async () => {
      const { io } = harness(db);
      // Оригинал подставлял значение в шаблон: `sl_1` ловил
      // `mp-sl-1-cli` (отклонение `fix`).
      const result = await runPs(args({ filter: "sl_1" }), io);
      assertEquals(result.containers, []);
    });

    await t.step("ноль совпадений — успех, а не отказ", async () => {
      const { io } = harness(db);
      const result = await runPs(args({ filter: "нет-такого" }), io);
      assertEquals(result.containers, []);
      assertEquals(psCommand.textExitCode(result), 0);
    });
  });
});

Deno.test("пустой кэш и отсутствие таблицы — разные исходы", async (t) => {
  await t.step("строк нет: строка в stderr и успех", async () => {
    await withCache([], async (db) => {
      const { io, progress } = harness(db);
      const result = await runPs(args(), io);
      assertEquals(result.containers, []);
      assertEquals(psCommand.textExitCode(result), 0);
      assertEquals(
        `${progress[1]}\n`,
        await golden("empty-cache-stderr.txt"),
      );
    });
  });

  await t.step("таблицы нет: доменная ошибка эталона канала", async () => {
    await withoutTable(async (db) => {
      const { io } = harness(db);
      const err = await assertRejects(() => runPs(args(), io), DomainError);
      assertEquals(
        `${formatCommandError("ps", err)}\n`,
        await golden("err-no-table-stderr.txt"),
      );
    });
  });
});

/**
 * Живой список из фикстуры канала: тем же разбором, каким его читает
 * сам клиент, — иначе новое поле `Status` и хардненные поля ответа не
 * проверялись бы ничем (`specs/ps.md`, «Golden-примеры»).
 */
async function liveFromFixture(): Promise<readonly PortainerContainer[]> {
  const raw = JSON.parse(
    await golden("live-containers-json.json"),
  ) as readonly {
    Id: string;
    Names: string[];
    State: string;
    Status: string;
    Image: string;
  }[];
  return raw.map((c) => ({
    id: c.Id,
    names: c.Names,
    state: c.State,
    status: c.Status,
    image: c.Image,
  }));
}

Deno.test("живой режим: STATUS, сортировка и фильтр", async (t) => {
  const live = await liveFromFixture();
  const seen: { access?: PortainerAccess; endpointId?: number } = {};
  const options: PsOptions = {
    listLive: (access, endpointId) => {
      seen.access = access;
      seen.endpointId = endpointId;
      return Promise.resolve(live);
    },
  };

  await withCache(CACHE, async (db) => {
    const { io } = harness(db);
    const result = await runPs(args({ selector: "sl-1" }), io, options);

    await t.step("таргет — строка кэша, а не env-fallback", () => {
      // Кэш старше fallback'а (тот же порядок, что у выбора транспорта),
      // поэтому endpoint берётся из строки сервера, а не из `sl_1_portainer`.
      assertEquals(seen.endpointId, 1);
      assertEquals(seen.access?.baseUrl, "https://portainer.example");
      assertEquals(seen.access?.apiKey, "k");
    });

    await t.step("колонка STATUS есть, порядок — по имени", () => {
      assertEquals(
        psCommand.renderResult(result, ["sl-1"]),
        "NAME                STATE    STATUS                    IMAGE\n" +
          "cadvisor            running  Up 3 days                 " +
          "registry.example/cadvisor:0.49\n" +
          "mp-sl-1-cli         running  Up 3 days                 " +
          "registry.example/app:1.2.3\n" +
          "mp-sl-1-migrations  exited   Exited (0) 3 days ago     " +
          "registry.example/app:1.2.3\n" +
          "mp-wb-loader-app    exited   Exited (137) 2 hours ago  " +
          "registry.example/loader:4.5\n",
      );
    });

    await t.step(
      "фильтр живого режима — тоже буквальная подстрока",
      async () => {
        const { io: io2 } = harness(db);
        // Отклонение `fix`: в кэш-режиме оригинал подставлял значение в
        // шаблон, живой искал подстроку — теперь оба ищут подстроку.
        const filtered = await runPs(
          args({ selector: "sl-1", filter: "sl_1" }),
          io2,
          { listLive: () => Promise.resolve(live) },
        );
        assertEquals(filtered.containers, []);
        const found = await runPs(
          args({ selector: "sl-1", filter: "wb-loader" }),
          harness(db).io,
          { listLive: () => Promise.resolve(live) },
        );
        assertEquals(found.containers.map((c) => c.name), ["mp-wb-loader-app"]);
      },
    );

    await t.step("--json живого списка: свои четыре ключа", () => {
      const items = JSON.parse(
        psCommand.renderResult(result, ["sl-1", "--json"]),
      );
      assertEquals(items[1], {
        name: "mp-sl-1-cli",
        state: "running",
        status: "Up 3 days",
        image: "registry.example/app:1.2.3",
      });
      // Ключа `endpoint` у живого списка нет: он есть только в кэше.
      assertEquals(Object.keys(items[0]), [
        "name",
        "state",
        "status",
        "image",
      ]);
    });

    await t.step("пустой живой список — своя строка, exit 0", async () => {
      const { io: io2 } = harness(db);
      const empty = await runPs(args({ selector: "sl-1" }), io2, {
        listLive: () => Promise.resolve([]),
      });
      assertEquals(
        psCommand.renderResult(empty, ["sl-1"]),
        "(no containers)\n",
      );
      assertEquals(psCommand.textExitCode(empty), 0);
    });
  });
});

Deno.test("живой режим: отказы конфигурации и сети", async (t) => {
  await t.step("нет ключа Portainer", async () => {
    await withCache(CACHE, async (db) => {
      const io = makeFakeIo({
        envFile: {
          get: () => undefined,
          values: () => ({}),
          require: () => "",
          set: () => Promise.reject(new Error("не ожидается")),
        },
        openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
        progress: () => {},
      }) as PsIo;
      await assertRejects(
        () => runPs(args({ selector: "sl-1" }), io),
        UsageError,
        "PORTAINER_API_KEY не задан в ~/.config/mpu/.env",
      );
    });
  });

  await t.step("сервер без Portainer-таргета", async () => {
    await withCache(CACHE, async (db) => {
      const { io } = harness(db);
      await assertRejects(
        () => runPs(args({ selector: "sl-9" }), io),
        UsageError,
        "для sl-9 не найден portainer-target",
      );
    });
  });

  await t.step("HTTP-ошибка Portainer — доменная, exit 1", async () => {
    await withCache(CACHE, async (db) => {
      const { io } = harness(db);
      const err = await assertRejects(
        () =>
          runPs(args({ selector: "sl-1" }), io, {
            listLive: () => Promise.reject(new PortainerError("HTTP 502")),
          }),
        DomainError,
      );
      assertEquals(
        formatCommandError("ps", err),
        "mpu ps: portainer error: HTTP 502",
      );
    });
  });
});

Deno.test("--json и --tsv вместе — ошибка ввода", async () => {
  const { io } = harness();
  // Отклонение `fix`: в оригинале молча побеждал `--json`.
  await assertRejects(
    () => runPs(args({ json: true, tsv: true }), io),
    UsageError,
    "--json и --tsv взаимоисключающие",
  );
});

Deno.test("объявление команды: политика и предел описания", async (t) => {
  await t.step("читающая команда — класс ro", () => {
    assertEquals(psCommand.path, ["ps"]);
    assertEquals(psCommand.policy, "ro");
  });

  await t.step("описание тула укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${psCommand.summary}\n\n${psCommand.help}`,
    ).length;
    assertEquals(bytes < 2048, true, `описание не влезло: ${bytes} байт`);
  });
});
