/**
 * Команда `mpu config` (`platform/config.md`): формы вывода против
 * эталонов канала, закрытый реестр, валидация до записи и то, что
 * источников значения ровно два.
 *
 * Хранилище настоящее — временная кэш-БД: подделка таблицы прошла бы
 * мимо ровно того дефекта, ради которого предпочтения туда переехали.
 *
 * Состав реестра у голденов оригинальный (пять ключей, без наших
 * `mcp.*`), поэтому список и подсказка сверяются по спеке, а форма
 * строки и тексты отказов — по фикстуре (`platform/config.md`).
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempCache, plainRows } from "../testing/cache.ts";
import { rejected } from "@mpu/testing/thrown";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { configValue, setConfigValue } from "./mod.ts";
import { configCommand, renderConfig, runConfig } from "./cmd_config.ts";
import { CONFIG_KEYS } from "./registry.ts";

/** Аргументы вызова; по умолчанию — голый `mpu config`. */
const args = (overrides: Record<string, unknown> = {}) =>
  ({
    key: undefined,
    value: undefined,
    unset: false,
    json: false,
    ...overrides,
  }) as Parameters<typeof runConfig>[0];

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/config/${name}`, import.meta.url),
    "utf8",
  );
}

/** `HOME` порта команды на стенде (`platform/config.md`, «Стенд»). */
const H = "/home/стенд";

/** Описание ключа `image.dir` — побайтово из спеки. */
const IMAGE_DIR_DESCRIPTION =
  "Каталог файлов методов образа для `mpu image sync` и `mpu image export`";

const TASK_HISTORY_DESCRIPTION =
  "Глубина журнала `mpu task` в порциях: 0 — только текущая, -1 — не чистить";

/** Седьмая строка списка — task.history (`task.md`, «Конфигурация»). */
const TASK_HISTORY_LINE = "task.history               3  (default)";

const TASK_MAX_BUSY_DESCRIPTION =
  "Предел одновременно занятых ролей оркестратора `mpu-task` по всем проектам";

/** Восьмая — task.max_busy (`task-orchestrator.md`, «Параллельные проекты»). */
const TASK_MAX_BUSY_LINE = "task.max_busy              4  (default)";

/** Прогон с настоящей БД во временном каталоге; `HOME` порта — `stand.home`. */
async function withIo(
  body: (io: ConfigIo, db: CacheDb) => Promise<void>,
  stand: { readonly home: string | undefined } = { home: H },
): Promise<void> {
  const { io, db, close } = await openIo(stand);
  try {
    await body(io, db);
  } finally {
    await close();
  }
}

type ConfigIo = Parameters<typeof runConfig>[1];

/**
 * То же окружение, что у `withIo`, на весь `describe`: открывается в
 * `beforeAll`, `close` — в `afterAll`.
 */
async function openIo(
  stand: { readonly home: string | undefined } = { home: H },
): Promise<{ io: ConfigIo; db: CacheDb; close: () => Promise<void> }> {
  const { db, close } = await openTempCache();
  const io = makeFakeIo({
    env: (name) => (name === "HOME" ? stand.home : undefined),
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
  });
  return { io, db, close };
}

/** Первые `n` строк текста — с переводом строки у каждой. */
function firstLines(text: string, n: number): string {
  return text
    .split("\n")
    .slice(0, n)
    .map((line) => `${line}\n`)
    .join("");
}

describe("список: пять строк эталона канала, шестая — image.dir (C1), седьмая — task.history, восьмая — task.max_busy", () => {
  // Голден снят на реестре оригинала — пять ключей; image.dir в него не
  // дописывается (`platform/config.md`, «Ключ image.dir»).
  const cases = [
    {
      home: H,
      line: `image.dir                  ${H}/mr/mp/mpu/image  (default)`,
    },
    { home: undefined, line: "image.dir                  (unset)  (default)" },
  ];
  for (const { home, line } of cases) {
    it(`HOME=${home}`, () =>
      withIo(
        async (io) => {
          const text = renderConfig(await runConfig(args(), io), false);
          expect(firstLines(text, 5)).toStrictEqual(
            await golden("list-default.stdout"),
          );
          expect(text.split("\n").slice(5)).toStrictEqual([
            line,
            TASK_HISTORY_LINE,
            TASK_MAX_BUSY_LINE,
            "",
          ]);
        },
        { home },
      ));
  }
});

it("список --json: форма записи — эталон канала", async () => {
  await withIo(async (io) => {
    const result = await runConfig(args({ json: true }), io);
    const entries = JSON.parse(renderConfig(result, true));
    const original = JSON.parse(await golden("list-json.stdout"));
    // Первые пять записей — голден дословно, вместе с описаниями: их
    // читает человек. Шестая — image.dir (C2), седьмая — task.history,
    // восьмая — task.max_busy.
    expect(entries.slice(0, 5)).toStrictEqual(original);
    expect(entries.slice(5)).toStrictEqual([
      {
        key: "image.dir",
        value: `${H}/mr/mp/mpu/image`,
        source: "default",
        default: `${H}/mr/mp/mpu/image`,
        description: IMAGE_DIR_DESCRIPTION,
      },
      {
        key: "task.history",
        value: "3",
        source: "default",
        default: "3",
        description: TASK_HISTORY_DESCRIPTION,
      },
      {
        key: "task.max_busy",
        value: "4",
        source: "default",
        default: "4",
        description: TASK_MAX_BUSY_DESCRIPTION,
      },
    ]);
  });
});

it("значение из хранилища печатается без суффикса источника", async () => {
  await withIo(async (io, db) => {
    setConfigValue(db, "sheet.default", "4326");
    const text = renderConfig(await runConfig(args(), io), false);
    // Суффикс — только у умолчания: пометить обычный случай значило бы
    // сделать вывод шумным ровно там, где смотреть не на что.
    expect(text.includes("sheet.default              4326\n"), text).toBe(true);
    const json = JSON.parse(
      renderConfig(await runConfig(args({ json: true }), io), true),
    );
    const entry = json.find(
      (row: { key: string }) => row.key === "sheet.default",
    );
    expect([entry.value, entry.source, entry.default]).toStrictEqual([
      "4326",
      "config",
      null,
    ]);
  });
});

describe("чтение одного ключа: pipe-friendly у строкового", () => {
  let io: ConfigIo;
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ io, db, close } = await openIo());
  });
  afterAll(() => close());

  it("строковый без записи — пустой вывод, exit 0", async () => {
    const result = await runConfig(args({ key: "sheet.default" }), io);
    expect(renderConfig(result, false)).toBe("");
  });

  it("числовой без записи — умолчание", async () => {
    const result = await runConfig(args({ key: "sheet.cache.tab_ttl" }), io);
    expect(renderConfig(result, false)).toBe("7200\n");
  });

  it("заданное значение печатается как есть", async () => {
    setConfigValue(db, "sheet.default", "4326");
    const result = await runConfig(args({ key: "sheet.default" }), io);
    expect(renderConfig(result, false)).toBe("4326\n");
  });
});

describe("запись: буквально, с проверкой int до хранилища", () => {
  let io: ConfigIo;
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ io, db, close } = await openIo());
  });
  afterAll(() => close());

  it("вывод записи — эталон канала", async () => {
    const result = await runConfig(
      args({ key: "sheet.cache.tab_ttl", value: "3600" }),
      io,
    );
    expect(renderConfig(result, false)).toStrictEqual(
      await golden("set-int.stdout"),
    );
    expect(configValue(db, "sheet.cache.tab_ttl")).toBe("3600");
  });

  it("значение хранится строкой буквально", async () => {
    await runConfig(
      args({ key: "sheet.cache.max_total_mb", value: "007" }),
      io,
    );
    // Нормализация «007» → «7» развела бы наше хранилище с рабочим
    // на ровном месте: таблица одна на обе реализации.
    expect(configValue(db, "sheet.cache.max_total_mb")).toBe("007");
  });

  it("нечисловое значение int-ключа — отказ до записи", async () => {
    const err = await rejected(
      () => runConfig(args({ key: "sheet.cache.tab_ttl", value: "abc" }), io),
      UsageError,
    );
    expect(`${formatCommandError("config", err)}\n`).toStrictEqual(
      await golden("err-int-value.stderr"),
    );
    // Хранилище не тронуто: прежнее значение на месте.
    expect(configValue(db, "sheet.cache.tab_ttl")).toBe("3600");
  });
});

describe("у ключей кэша границ нет намеренно", () => {
  let io: ConfigIo;
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ io, db, close } = await openIo());
  });
  afterAll(() => close());

  it("ноль и миллиард принимаются", async () => {
    // Оригинал принимает и ноль, и миллиард; потребитель отбрасывает
    // несуразное сам, с заметкой в журнал (отклонение preserve).
    await runConfig(args({ key: "sheet.cache.tab_ttl", value: "0" }), io);
    expect(configValue(db, "sheet.cache.tab_ttl")).toBe("0");
    await runConfig(
      args({ key: "sheet.cache.max_total_mb", value: "999999999" }),
      io,
    );
    expect(configValue(db, "sheet.cache.max_total_mb")).toBe("999999999");
  });
});

describe("--unset идемпотентен и печатает умолчание", () => {
  let io: ConfigIo;
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ io, db, close } = await openIo());
    setConfigValue(db, "sheet.cache.tab_ttl", "3600");
  });
  afterAll(() => close());

  it("первый вызов — эталон канала", async () => {
    const result = await runConfig(
      args({ key: "sheet.cache.tab_ttl", unset: true }),
      io,
    );
    expect(renderConfig(result, false)).toStrictEqual(
      await golden("unset.stdout"),
    );
    expect(configValue(db, "sheet.cache.tab_ttl")).toStrictEqual(undefined);
  });

  it("повторный — та же строка и успех", async () => {
    const result = await runConfig(
      args({ key: "sheet.cache.tab_ttl", unset: true }),
      io,
    );
    expect(renderConfig(result, false)).toStrictEqual(
      await golden("unset.stdout"),
    );
  });

  it("у ключа без умолчания печатается (unset)", async () => {
    const result = await runConfig(
      args({ key: "sheet.default", unset: true }),
      io,
    );
    expect(renderConfig(result, false)).toBe(
      "sheet.default сброшен к дефолту: (unset)\n",
    );
  });
});

describe("реестр закрыт: имя вне списка не создаёт записи", () => {
  let io: ConfigIo;
  let db: CacheDb;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ io, db, close } = await openIo());
    for (const call of [
      args({ key: "nope.key" }),
      args({ key: "nope.key", value: "1" }),
      args({ key: "nope.key", unset: true }),
    ]) {
      const err = await rejected(() => runConfig(call, io), UsageError);
      expect(err.message, JSON.stringify(call)).toBe(
        `unknown config key: "nope.key"`,
      );
    }
  });
  afterAll(() => close());

  it("записи «на лету» не появилось", () => {
    expect(configValue(db, "nope.key")).toStrictEqual(undefined);
    // Таблицы нет вовсе: отказ случился до всякой записи, а bootstrap
    // делает только она.
    expect(
      plainRows(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          "config",
        ),
      ),
    ).toStrictEqual([]);
  });

  it("подсказка перечисляет ключи реестра", async () => {
    const err = await rejected(
      () => runConfig(args({ key: "nope.key" }), io),
      UsageError,
    );
    const text = formatCommandError("config", err);
    const tail = (await golden("err-unknown-key.stderr"))
      .trim()
      .split("допустимые ключи: ")[1];
    // Состав — голден, image.dir, task.history и task.max_busy
    // (`platform/config.md`).
    expect(
      text.endsWith(`${tail}, image.dir, task.history, task.max_busy`),
      text,
    ).toBe(true);
  });
});

it("--unset без ключа — отказ, эталон канала", async () => {
  await withIo(async (io) => {
    const err = await rejected(
      () => runConfig(args({ unset: true }), io),
      UsageError,
    );
    expect(`${formatCommandError("config", err)}\n`).toStrictEqual(
      await golden("err-unset-no-key.stderr"),
    );
  });
});

it("переменные окружения на выдачу не влияют никак", async () => {
  // Ломать порт `io.env` мало: он проверил бы только то, что команда
  // не зовёт наш же порт. Здесь выставляются настоящие переменные с
  // «подходящими» именами — теми, что действовали в оригинале и теми,
  // в какие имя ключа превращается механически.
  const names = [
    "MCP_PORT",
    "MPU_MCP_PORT",
    "SHEET_DEFAULT",
    "MPU_SHEET_DEFAULT",
    "MPU_SS",
    "SHEET_CACHE_TAB_TTL",
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "9999";
    await withIo(async (io, db) => {
      const list = renderConfig(await runConfig(args(), io), false);
      // Ни одного «9999»: источников значения два, и окружения среди
      // них нет (`platform/config.md`, «Граничные случаи»).
      expect(list.includes("9999"), list).toBe(false);
      expect(
        renderConfig(
          await runConfig(args({ key: "sheet.cache.tab_ttl" }), io),
          false,
        ),
      ).toBe("7200\n");
      expect(
        renderConfig(
          await runConfig(args({ key: "sheet.default" }), io),
          false,
        ),
      ).toBe("");
      // И запись в хранилище от окружения тоже не зависит.
      setConfigValue(db, "sheet.cache.tab_ttl", "7000");
      expect(
        renderConfig(
          await runConfig(args({ key: "sheet.cache.tab_ttl" }), io),
          false,
        ),
      ).toBe("7000\n");
    });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

it("реестр: восемь ключей по порядку спеки, task.max_busy последним", () => {
  expect(CONFIG_KEYS.map((entry) => entry.key)).toStrictEqual([
    "sheet.default",
    "xlsx.default",
    "sheet.cache.tab_ttl",
    "sheet.cache.max_tab_bytes",
    "sheet.cache.max_total_mb",
    "image.dir",
    "task.history",
    "task.max_busy",
  ]);
});

it("справка config перечисляет ключи из реестра", () => {
  const listed = CONFIG_KEYS.map((entry) => entry.key).join(", ");
  expect(configCommand.help.includes(listed), configCommand.help).toBe(true);
});

it("unset image.dir печатает умолчание от HOME (C3)", async () => {
  await withIo(async (io) => {
    await runConfig(args({ key: "image.dir", value: "/tmp/x" }), io);
    const result = await runConfig(args({ key: "image.dir", unset: true }), io);
    expect(renderConfig(result, false)).toStrictEqual(
      `image.dir сброшен к дефолту: ${H}/mr/mp/mpu/image\n`,
    );
  });
});

it("пустое значение не оседает невидимой строкой", async () => {
  await withIo(async (io, db) => {
    // `mpu config sheet.default "$SS"` с пустой переменной: пустая
    // строка читается хранилищем как «записи нет», то есть заняла бы
    // место, которого не видно ни в списке, ни в --json.
    const err = await rejected(
      () => runConfig(args({ key: "sheet.default", value: "" }), io),
      UsageError,
      "пустое значение не задаётся; сбросить ключ — unset",
    );
    expect(err instanceof UsageError).toBe(true);
    expect(configValue(db, "sheet.default")).toStrictEqual(undefined);
    expect(
      plainRows(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          "config",
        ),
      ),
      "хранилище не тронуто",
    ).toStrictEqual([]);
  });
});

it("--unset вместе со значением — отказ, а не тихое проглатывание", async () => {
  await withIo(async (io, db) => {
    setConfigValue(db, "sheet.default", "4326");
    await rejected(
      () =>
        runConfig(
          args({ key: "sheet.default", value: "8888", unset: true }),
          io,
        ),
      UsageError,
      "unset не сочетается с value:",
    );
    // Ни удаления, ни записи: два действия сразу — это ошибка ввода.
    expect(configValue(db, "sheet.default")).toBe("4326");
  });
});

describe("ввод разбирается до хранилища: отказ не создаёт файла БД", () => {
  let dir: string;
  let dbPath: string;
  let io: ConfigIo;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpu-"));
    dbPath = `${dir}/mpu.db`;
    io = makeFakeIo({ openCacheDb: () => openCacheDb(dbPath) });
  });
  afterAll(() => rm(dir, { recursive: true }));

  const cases: readonly [string, Parameters<typeof runConfig>[0]][] = [
    ["имя вне реестра", args({ key: "nope.key" })],
    ["нечисловое значение", args({ key: "sheet.cache.tab_ttl", value: "abc" })],
    ["--unset без ключа", args({ unset: true })],
    ["пустое значение", args({ key: "sheet.default", value: "" })],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      await expect(runConfig(call, io)).rejects.toThrow(UsageError);
    });
  }

  it("файла БД не появилось", async () => {
    // Открытие кэш-БД создаёт каталог и файл: отказ ввода не должен
    // оставлять следа, а на машине без HOME — подменяться отказом
    // инфраструктуры с кодом 1 вместо 2.
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("чтение работает и без хранилища — по умолчаниям", () => {
  const io = makeFakeIo({
    openCacheDb: () => {
      throw new DomainError("путь к кэш-БД не определён: HOME не задан");
    },
  });

  it("список печатается целиком", async () => {
    const text = renderConfig(await runConfig(args(), io), false);
    expect(text.split("\n").length - 1).toStrictEqual(CONFIG_KEYS.length);
    expect(text.includes("7200  (default)"), text).toBe(true);
  });

  it("чтение ключа отдаёт умолчание", async () => {
    const result = await runConfig(args({ key: "sheet.cache.tab_ttl" }), io);
    expect(renderConfig(result, false)).toBe("7200\n");
  });

  it("запись без хранилища — отказ инфраструктуры", async () => {
    await rejected(
      () => runConfig(args({ key: "sheet.cache.tab_ttl", value: "7000" }), io),
      DomainError,
      "путь к кэш-БД не определён",
    );
  });
});
