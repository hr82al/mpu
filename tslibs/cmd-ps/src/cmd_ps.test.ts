/**
 * Команда `mpu ps` (`docs/specs/ps.md`). Кэш настоящий, во временном
 * каталоге; живой список — подставной, сети в тестах нет. Наблюдаемое —
 * эталоны канала, строки stderr и коды ошибок.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeFakeIo,
  openTempCache,
  type TempCache,
} from "@mpu/command/testing";
import { rejected } from "@mpu/testing/thrown";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  UsageError,
} from "@mpu/command";
import type { PortainerAccess, PortainerContainer } from "@mpu/portainer";
import { PortainerError } from "@mpu/portainer";
import { openCacheDb } from "@mpu/command/store";
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
  return await readFile(
    new URL(`./testdata/ps/${name}`, import.meta.url),
    "utf8",
  );
}

/** Кэш-БД во временном каталоге; `rows` пуст — таблица есть, строк нет. */
async function withCache(
  rows: typeof CACHE,
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const { db, close } = await openCache(rows);
  try {
    await body(db);
  } finally {
    await close();
  }
}

/**
 * Та же кэш-БД на весь `describe`: открывается в `beforeAll`, `close` — в
 * `afterAll`.
 */
function openCache(rows: typeof CACHE): Promise<TempCache> {
  return openTempCache((db) => {
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
  });
}

/** Кэш-БД без схемы: таблицы контейнеров в ней нет вовсе. */
async function withoutTable(body: (db: CacheDb) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("кэш-режим: три формы вывода — эталоны канала", () => {
  let db: CacheDb;
  let close: () => Promise<void>;
  let progress: readonly string[];
  let result: Awaited<ReturnType<typeof runPs>>;
  beforeAll(async () => {
    ({ db, close } = await openCache(CACHE));
    const harnessed = harness(db);
    progress = harnessed.progress;
    result = await runPs(args(), harnessed.io);
  });
  afterAll(() => close());

  it("таблица", async () => {
    expect(psCommand.renderResult(result, [])).toStrictEqual(
      await golden("cache-table-stdout.txt"),
    );
  });

  it("строка про кэш — в stderr, первой", async () => {
    expect(progress.map((line) => `${line}\n`).join("")).toStrictEqual(
      await golden("cache-table-stderr.txt"),
    );
  });

  it("--json", async () => {
    expect(psCommand.renderResult(result, ["--json"])).toStrictEqual(
      await golden("cache-json-stdout.txt"),
    );
  });

  it("--tsv", async () => {
    expect(psCommand.renderResult(result, ["--tsv"])).toStrictEqual(
      await golden("cache-tsv-stdout.txt"),
    );
  });
});

describe("кэш-режим: фильтр — буквальная подстрока", () => {
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openCache(CACHE));
  });
  afterAll(() => close());

  it("совпадение — эталон канала", async () => {
    const { io } = harness(db);
    const result = await runPs(args({ filter: "wb-loader" }), io);
    expect(psCommand.renderResult(result, [])).toStrictEqual(
      await golden("cache-filter-stdout.txt"),
    );
  });

  it("регистр не учитывается и в кэш-режиме", async () => {
    const { io } = harness(db);
    const result = await runPs(args({ filter: "WB-LOADER" }), io);
    expect(result.containers.map((c) => c.name)).toStrictEqual([
      "mp-wb-loader-app",
    ]);
  });

  it("`_` не значит «любой символ»", async () => {
    const { io } = harness(db);
    // Оригинал подставлял значение в шаблон: `sl_1` ловил
    // `mp-sl-1-cli` (отклонение `fix`).
    const result = await runPs(args({ filter: "sl_1" }), io);
    expect(result.containers).toStrictEqual([]);
  });

  it("ноль совпадений — успех, а не отказ", async () => {
    const { io } = harness(db);
    const result = await runPs(args({ filter: "нет-такого" }), io);
    expect(result.containers).toStrictEqual([]);
    expect(psCommand.textExitCode(result)).toBe(0);
  });
});

describe("пустой кэш и отсутствие таблицы — разные исходы", () => {
  it("строк нет: строка в stderr и успех", async () => {
    await withCache([], async (db) => {
      const { io, progress } = harness(db);
      const result = await runPs(args(), io);
      expect(result.containers).toStrictEqual([]);
      expect(psCommand.textExitCode(result)).toBe(0);
      expect(`${progress[1]}\n`).toStrictEqual(
        await golden("empty-cache-stderr.txt"),
      );
    });
  });

  it("таблицы нет: доменная ошибка эталона канала", async () => {
    await withoutTable(async (db) => {
      const { io } = harness(db);
      const err = await rejected(() => runPs(args(), io), DomainError);
      expect(`${formatCommandError("ps", err)}\n`).toStrictEqual(
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

describe("живой режим: STATUS, сортировка и фильтр", () => {
  let live: readonly PortainerContainer[];
  const seen: { access?: PortainerAccess; endpointId?: number } = {};
  const options: PsOptions = {
    listLive: (access, endpointId) => {
      seen.access = access;
      seen.endpointId = endpointId;
      return Promise.resolve(live);
    },
  };

  let db: CacheDb;
  let close: () => Promise<void>;
  let io: ReturnType<typeof harness>["io"];
  let result: Awaited<ReturnType<typeof runPs>>;
  beforeAll(async () => {
    live = await liveFromFixture();
    ({ db, close } = await openCache(CACHE));
    ({ io } = harness(db));
    result = await runPs(args({ selector: "sl-1" }), io, options);
  });
  afterAll(() => close());

  it("таргет — строка кэша, а не env-fallback", () => {
    // Кэш старше fallback'а (тот же порядок, что у выбора транспорта),
    // поэтому endpoint берётся из строки сервера, а не из `sl_1_portainer`.
    expect(seen.endpointId).toBe(1);
    expect(seen.access?.baseUrl).toBe("https://portainer.example");
    expect(seen.access?.apiKey).toBe("k");
  });

  it("колонка STATUS есть, порядок — по имени", () => {
    expect(psCommand.renderResult(result, ["sl-1"])).toStrictEqual(
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

  it("регистр фильтра не учитывается в живом режиме", async () => {
    // Один флаг одной команды не может значить разное: кэш сравнивает
    // без учёта регистра свойством `LIKE`, живой режим приведён к нему
    // (спека, отклонение `fix`).
    const found = await runPs(
      args({ selector: "sl-1", filter: "WB-LOADER" }),
      harness(db).io,
      { listLive: () => Promise.resolve(live) },
    );
    expect(found.containers.map((c) => c.name)).toStrictEqual([
      "mp-wb-loader-app",
    ]);
  });

  it("имя выходит в исходном написании, не приведённым", () => {
    // Приводится к нижнему регистру только сравнение: нормализованное
    // имя, попавшее в таргеты, адресовало бы несуществующий контейнер.
    const mixed: readonly PortainerContainer[] = [
      {
        id: "m",
        names: ["/Mp-WB-Loader-App"],
        state: "running",
        status: "Up 1 hour",
        image: "образ",
      },
    ];
    return runPs(
      args({ selector: "sl-1", filter: "wb-loader" }),
      harness(db).io,
      { listLive: () => Promise.resolve(mixed) },
    ).then((result) => {
      expect(result.containers.map((c) => c.name)).toStrictEqual([
        "Mp-WB-Loader-App",
      ]);
    });
  });

  it("фильтр живого режима — тоже буквальная подстрока", async () => {
    const { io: io2 } = harness(db);
    // Отклонение `fix`: в кэш-режиме оригинал подставлял значение в
    // шаблон, живой искал подстроку — теперь оба ищут подстроку.
    const filtered = await runPs(
      args({ selector: "sl-1", filter: "sl_1" }),
      io2,
      { listLive: () => Promise.resolve(live) },
    );
    expect(filtered.containers).toStrictEqual([]);
    const found = await runPs(
      args({ selector: "sl-1", filter: "wb-loader" }),
      harness(db).io,
      { listLive: () => Promise.resolve(live) },
    );
    expect(found.containers.map((c) => c.name)).toStrictEqual([
      "mp-wb-loader-app",
    ]);
  });

  it("--json живого списка: свои четыре ключа", () => {
    const items = JSON.parse(
      psCommand.renderResult(result, ["sl-1", "--json"]),
    );
    expect(items[1]).toStrictEqual({
      name: "mp-sl-1-cli",
      state: "running",
      status: "Up 3 days",
      image: "registry.example/app:1.2.3",
    });
    // Ключа `endpoint` у живого списка нет: он есть только в кэше.
    expect(Object.keys(items[0])).toStrictEqual([
      "name",
      "state",
      "status",
      "image",
    ]);
  });

  it("пустой живой список — своя строка, exit 0", async () => {
    const { io: io2 } = harness(db);
    const empty = await runPs(args({ selector: "sl-1" }), io2, {
      listLive: () => Promise.resolve([]),
    });
    expect(psCommand.renderResult(empty, ["sl-1"])).toBe("(no containers)\n");
    expect(psCommand.textExitCode(empty)).toBe(0);
  });
});

describe("живой режим: отказы конфигурации и сети", () => {
  it("нет ключа Portainer", async () => {
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
      await rejected(
        () => runPs(args({ selector: "sl-1" }), io),
        UsageError,
        "PORTAINER_API_KEY не задан в ~/.config/mpu/.env",
      );
    });
  });

  it("сервер без Portainer-таргета", async () => {
    await withCache(CACHE, async (db) => {
      const { io } = harness(db);
      await rejected(
        () => runPs(args({ selector: "sl-9" }), io),
        UsageError,
        "для sl-9 не найден portainer-target",
      );
    });
  });

  it("HTTP-ошибка Portainer — доменная, exit 1", async () => {
    await withCache(CACHE, async (db) => {
      const { io } = harness(db);
      const err = await rejected(
        () =>
          runPs(args({ selector: "sl-1" }), io, {
            listLive: () => Promise.reject(new PortainerError("HTTP 502")),
          }),
        DomainError,
      );
      expect(formatCommandError("ps", err)).toBe(
        "mpu ps: portainer error: HTTP 502",
      );
    });
  });
});

it("--json и --tsv вместе — ошибка ввода", async () => {
  const { io } = harness();
  // Отклонение `fix`: в оригинале молча побеждал `--json`.
  await rejected(
    () => runPs(args({ json: true, tsv: true }), io),
    UsageError,
    "--json и --tsv взаимоисключающие",
  );
});

describe("объявление команды: политика и предел описания", () => {
  it("читающая команда — класс ro", () => {
    expect(psCommand.path).toStrictEqual(["ps"]);
    expect(psCommand.policy).toBe("ro");
  });

  it("описание тула укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${psCommand.summary}\n\n${psCommand.help}`,
    ).length;
    expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
  });
});
