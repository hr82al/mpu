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

import { assertEquals, assertRejects } from "@std/assert";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { configValue, setConfigValue } from "./mod.ts";
import { renderConfig, runConfig } from "./cmd_config.ts";
import { CONFIG_KEYS } from "./registry.ts";
import { DEFAULT_PORT } from "../mcp/server.ts";
import { DEFAULTS } from "../sheet/settings.ts";

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
  return await Deno.readTextFile(
    new URL(`./testdata/config/${name}`, import.meta.url),
  );
}

/** Прогон с настоящей БД во временном каталоге. */
async function withIo(
  body: (io: { openCacheDb: () => CacheDb }, db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    const io = makeFakeIo({
      openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    });
    await body(io, db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("список: форма строки — эталон канала", async () => {
  await withIo(async (io) => {
    const result = await runConfig(args(), io);
    const text = renderConfig(result, false);
    // Голден снят на реестре оригинала — пять ключей; у нас их семь,
    // поэтому сверяется хвост: форма строки, ширина колонки и то, что
    // суффикс (default) стоит у каждого незаданного значения.
    assertEquals(
      text.endsWith(await golden("list-default.stdout")),
      true,
      text,
    );
    assertEquals(text.split("\n").length - 1, CONFIG_KEYS.length);
    assertEquals(
      text.startsWith("mcp.port                   7337  (default)\n"),
      true,
      text,
    );
  });
});

Deno.test("список --json: форма записи — эталон канала", async () => {
  await withIo(async (io) => {
    const result = await runConfig(args({ json: true }), io);
    const entries = JSON.parse(renderConfig(result, true));
    const original = JSON.parse(await golden("list-json.stdout"));
    assertEquals(entries.length, CONFIG_KEYS.length);
    // Пять записей оригинала обязаны совпасть с голденом дословно —
    // вместе с описаниями: их читает человек.
    assertEquals(entries.slice(1), original);
    // Наша запись в голдене отсутствует, поэтому проверяется здесь: у
    // неё есть умолчание, и источник у него один.
    assertEquals(entries[0], {
      key: "mcp.port",
      value: "7337",
      source: "default",
      default: "7337",
      description: "Порт HTTP-сервера `mpu mcp`",
    });
  });
});

Deno.test("значение из хранилища печатается без суффикса источника", async () => {
  await withIo(async (io, db) => {
    setConfigValue(db, "sheet.default", "4326");
    const text = renderConfig(await runConfig(args(), io), false);
    // Суффикс — только у умолчания: пометить обычный случай значило бы
    // сделать вывод шумным ровно там, где смотреть не на что.
    assertEquals(
      text.includes("sheet.default              4326\n"),
      true,
      text,
    );
    const json = JSON.parse(
      renderConfig(await runConfig(args({ json: true }), io), true),
    );
    const entry = json.find((row: { key: string }) =>
      row.key === "sheet.default"
    );
    assertEquals([entry.value, entry.source, entry.default], [
      "4326",
      "config",
      null,
    ]);
  });
});

Deno.test("чтение одного ключа: pipe-friendly у строкового", async (t) => {
  await withIo(async (io, db) => {
    await t.step("строковый без записи — пустой вывод, exit 0", async () => {
      const result = await runConfig(args({ key: "sheet.default" }), io);
      assertEquals(renderConfig(result, false), "");
    });

    await t.step("числовой без записи — умолчание", async () => {
      const result = await runConfig(args({ key: "sheet.cache.tab_ttl" }), io);
      assertEquals(renderConfig(result, false), "7200\n");
    });

    await t.step("заданное значение печатается как есть", async () => {
      setConfigValue(db, "sheet.default", "4326");
      const result = await runConfig(args({ key: "sheet.default" }), io);
      assertEquals(renderConfig(result, false), "4326\n");
    });
  });
});

Deno.test("запись: буквально, с проверкой int до хранилища", async (t) => {
  await withIo(async (io, db) => {
    await t.step("вывод записи — эталон канала", async () => {
      const result = await runConfig(
        args({ key: "sheet.cache.tab_ttl", value: "3600" }),
        io,
      );
      assertEquals(renderConfig(result, false), await golden("set-int.stdout"));
      assertEquals(configValue(db, "sheet.cache.tab_ttl"), "3600");
    });

    await t.step("значение хранится строкой буквально", async () => {
      await runConfig(args({ key: "mcp.port", value: "007" }), io);
      // Нормализация «007» → «7» развела бы наше хранилище с рабочим
      // на ровном месте: таблица одна на обе реализации.
      assertEquals(configValue(db, "mcp.port"), "007");
    });

    await t.step(
      "нечисловое значение int-ключа — отказ до записи",
      async () => {
        const err = await assertRejects(
          () =>
            runConfig(args({ key: "sheet.cache.tab_ttl", value: "abc" }), io),
          UsageError,
        );
        assertEquals(
          `${formatCommandError("config", err)}\n`,
          await golden("err-int-value.stderr"),
        );
        // Хранилище не тронуто: прежнее значение на месте.
        assertEquals(configValue(db, "sheet.cache.tab_ttl"), "3600");
      },
    );
  });
});

Deno.test("mcp.port проверяется диапазоном, sheet.cache.* — нет", async (t) => {
  await withIo(async (io, db) => {
    await t.step("порт вне 1–65535 — отказ до записи", async () => {
      for (const value of ["0", "65536", "99999"]) {
        await assertRejects(
          () => runConfig(args({ key: "mcp.port", value }), io),
          UsageError,
          `mcp.port ожидает порт 1–65535, получено "${value}"`,
        );
      }
      // Иначе `mpu config` показывал бы 99999, пока сервер слушает
      // умолчание: parsePort молча заменяет несуразное значение.
      assertEquals(configValue(db, "mcp.port"), undefined);
    });

    await t.step("границы диапазона допустимы", async () => {
      await runConfig(args({ key: "mcp.port", value: "1" }), io);
      assertEquals(configValue(db, "mcp.port"), "1");
      await runConfig(args({ key: "mcp.port", value: "65535" }), io);
      assertEquals(configValue(db, "mcp.port"), "65535");
    });

    await t.step("у ключей кэша границ нет намеренно", async () => {
      // Оригинал принимает и ноль, и миллиард; потребитель отбрасывает
      // несуразное сам, с заметкой в журнал (отклонение preserve).
      await runConfig(args({ key: "sheet.cache.tab_ttl", value: "0" }), io);
      assertEquals(configValue(db, "sheet.cache.tab_ttl"), "0");
      await runConfig(
        args({ key: "sheet.cache.max_total_mb", value: "999999999" }),
        io,
      );
      assertEquals(configValue(db, "sheet.cache.max_total_mb"), "999999999");
    });
  });
});

Deno.test("--unset идемпотентен и печатает умолчание", async (t) => {
  await withIo(async (io, db) => {
    setConfigValue(db, "sheet.cache.tab_ttl", "3600");

    await t.step("первый вызов — эталон канала", async () => {
      const result = await runConfig(
        args({ key: "sheet.cache.tab_ttl", unset: true }),
        io,
      );
      assertEquals(renderConfig(result, false), await golden("unset.stdout"));
      assertEquals(configValue(db, "sheet.cache.tab_ttl"), undefined);
    });

    await t.step("повторный — та же строка и успех", async () => {
      const result = await runConfig(
        args({ key: "sheet.cache.tab_ttl", unset: true }),
        io,
      );
      assertEquals(renderConfig(result, false), await golden("unset.stdout"));
    });

    await t.step("у ключа без умолчания печатается (unset)", async () => {
      const result = await runConfig(
        args({ key: "sheet.default", unset: true }),
        io,
      );
      assertEquals(
        renderConfig(result, false),
        "sheet.default сброшен к дефолту: (unset)\n",
      );
    });
  });
});

Deno.test("реестр закрыт: имя вне списка не создаёт записи", async (t) => {
  await withIo(async (io, db) => {
    for (
      const call of [
        args({ key: "nope.key" }),
        args({ key: "nope.key", value: "1" }),
        args({ key: "nope.key", unset: true }),
      ]
    ) {
      const err = await assertRejects(() => runConfig(call, io), UsageError);
      assertEquals(
        err.message,
        `unknown config key: "nope.key"`,
        JSON.stringify(call),
      );
    }

    await t.step("записи «на лету» не появилось", () => {
      assertEquals(configValue(db, "nope.key"), undefined);
      // Таблицы нет вовсе: отказ случился до всякой записи, а bootstrap
      // делает только она.
      assertEquals(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          "config",
        ),
        [],
      );
    });

    await t.step("подсказка перечисляет ключи реестра", async () => {
      const err = await assertRejects(
        () => runConfig(args({ key: "nope.key" }), io),
        UsageError,
      );
      const text = formatCommandError("config", err);
      const tail = (await golden("err-unknown-key.stderr")).trim()
        .split("допустимые ключи: ")[1];
      // Состав у голдена оригинальный (без нашего mcp.port), поэтому
      // сверяется хвост перечня и форма подсказки.
      assertEquals(text.endsWith(tail), true, text);
      assertEquals(text.includes("mcp.port, sheet.default"), true, text);
    });
  });
});

Deno.test("--unset без ключа — отказ, эталон канала", async () => {
  await withIo(async (io) => {
    const err = await assertRejects(
      () => runConfig(args({ unset: true }), io),
      UsageError,
    );
    assertEquals(
      `${formatCommandError("config", err)}\n`,
      await golden("err-unset-no-key.stderr"),
    );
  });
});

Deno.test("переменные окружения на выдачу не влияют никак", async () => {
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
  const saved = new Map(names.map((name) => [name, Deno.env.get(name)]));
  try {
    for (const name of names) Deno.env.set(name, "9999");
    await withIo(async (io, db) => {
      const list = renderConfig(await runConfig(args(), io), false);
      // Ни одного «9999»: источников значения два, и окружения среди
      // них нет (`platform/config.md`, «Граничные случаи»).
      assertEquals(list.includes("9999"), false, list);
      assertEquals(
        renderConfig(await runConfig(args({ key: "mcp.port" }), io), false),
        "7337\n",
      );
      assertEquals(
        renderConfig(
          await runConfig(args({ key: "sheet.default" }), io),
          false,
        ),
        "",
      );
      // И запись в хранилище от окружения тоже не зависит.
      setConfigValue(db, "mcp.port", "7000");
      assertEquals(
        renderConfig(await runConfig(args({ key: "mcp.port" }), io), false),
        "7000\n",
      );
    });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("реестр: шесть ключей по порядку спеки", () => {
  assertEquals(CONFIG_KEYS.map((entry) => entry.key), [
    "mcp.port",
    "sheet.default",
    "xlsx.default",
    "sheet.cache.tab_ttl",
    "sheet.cache.max_tab_bytes",
    "sheet.cache.max_total_mb",
  ]);
});

Deno.test("умолчания реестра совпадают с теми, что применяют потребители", () => {
  // Реестр показывает оператору, что действует без записи, а
  // применяют значения другие модули. Разойдясь, они сделали бы
  // `mpu config` красивой ложью: печатает одно, работает другое.
  const fallback = (key: string) =>
    CONFIG_KEYS.find((entry) => entry.key === key)?.fallback;
  assertEquals(fallback("mcp.port"), String(DEFAULT_PORT));
  assertEquals(fallback("sheet.cache.tab_ttl"), String(DEFAULTS.tabTtlSeconds));
  assertEquals(
    fallback("sheet.cache.max_tab_bytes"),
    String(DEFAULTS.maxTabBytes),
  );
  assertEquals(
    fallback("sheet.cache.max_total_mb"),
    String(DEFAULTS.maxTotalMb),
  );
  // У целей команд умолчания нет вовсе: не задано — значит не задано.
  assertEquals(fallback("sheet.default"), undefined);
  assertEquals(fallback("xlsx.default"), undefined);
});

Deno.test("пустое значение не оседает невидимой строкой", async () => {
  await withIo(async (io, db) => {
    // `mpu config sheet.default "$SS"` с пустой переменной: пустая
    // строка читается хранилищем как «записи нет», то есть заняла бы
    // место, которого не видно ни в списке, ни в --json.
    const err = await assertRejects(
      () => runConfig(args({ key: "sheet.default", value: "" }), io),
      UsageError,
      "пустое значение не задаётся; сбросить ключ — --unset",
    );
    assertEquals(err instanceof UsageError, true);
    assertEquals(configValue(db, "sheet.default"), undefined);
    assertEquals(
      db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        "config",
      ),
      [],
      "хранилище не тронуто",
    );
  });
});

Deno.test("--unset вместе со значением — отказ, а не тихое проглатывание", async () => {
  await withIo(async (io, db) => {
    setConfigValue(db, "sheet.default", "4326");
    await assertRejects(
      () =>
        runConfig(
          args({ key: "sheet.default", value: "8888", unset: true }),
          io,
        ),
      UsageError,
      "--unset не сочетается со значением",
    );
    // Ни удаления, ни записи: два действия сразу — это ошибка ввода.
    assertEquals(configValue(db, "sheet.default"), "4326");
  });
});

Deno.test("ввод разбирается до хранилища: отказ не создаёт файла БД", async (t) => {
  const dir = await Deno.makeTempDir();
  try {
    const dbPath = `${dir}/mpu.db`;
    const io = makeFakeIo({ openCacheDb: () => openCacheDb(dbPath) });

    const cases: readonly [string, Parameters<typeof runConfig>[0]][] = [
      ["имя вне реестра", args({ key: "nope.key" })],
      ["нечисловое значение", args({ key: "mcp.port", value: "abc" })],
      ["--unset без ключа", args({ unset: true })],
      ["пустое значение", args({ key: "sheet.default", value: "" })],
    ];
    for (const [name, call] of cases) {
      await t.step(name, async () => {
        await assertRejects(() => runConfig(call, io), UsageError);
      });
    }

    await t.step("файла БД не появилось", async () => {
      // Открытие кэш-БД создаёт каталог и файл: отказ ввода не должен
      // оставлять следа, а на машине без HOME — подменяться отказом
      // инфраструктуры с кодом 1 вместо 2.
      await assertRejects(() => Deno.stat(dbPath), Deno.errors.NotFound);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("чтение работает и без хранилища — по умолчаниям", async (t) => {
  const io = makeFakeIo({
    openCacheDb: () => {
      throw new DomainError("путь к кэш-БД не определён: HOME не задан");
    },
  });

  await t.step("список печатается целиком", async () => {
    const text = renderConfig(await runConfig(args(), io), false);
    assertEquals(text.split("\n").length - 1, CONFIG_KEYS.length);
    assertEquals(text.includes("7337  (default)"), true, text);
  });

  await t.step("чтение ключа отдаёт умолчание", async () => {
    const result = await runConfig(args({ key: "mcp.port" }), io);
    assertEquals(renderConfig(result, false), "7337\n");
  });

  await t.step("запись без хранилища — отказ инфраструктуры", async () => {
    await assertRejects(
      () => runConfig(args({ key: "mcp.port", value: "7000" }), io),
      DomainError,
      "путь к кэш-БД не определён",
    );
  });
});
