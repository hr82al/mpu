/**
 * Подкоманды `mpu sheet` (`docs/specs/sheet.md`): формы вывода против
 * эталонов канала, кэш листов и отказы ввода.
 *
 * Живого webapp здесь нет: канал подставной, а кэш-БД настоящая — она
 * и есть то, что отличает первый вызов от повторного.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { setConfigValue } from "../config/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { runGet, sheetGetCommand } from "./cmd_get.ts";
import { runLs, sheetLsCommand } from "./cmd_ls.ts";
import { sheetResolveCommand } from "./cmd_resolve.ts";

const SS_ID = "1SyntheticSpreadsheetIdForGoldens0000000000";

/** Лист служебной таблицы: `A1="привет"`, `B1=42`, `B2==B1*2`. */
const SHEET_META = {
  sheets: [{
    properties: {
      title: "Sheet1",
      sheetId: 0,
      index: 0,
      gridProperties: { rowCount: 1000, columnCount: 26 },
    },
  }],
};

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/sheet/${name}`, import.meta.url),
  );
}

/** Ответ webapp по экшену; значения — с той же служебной таблицы. */
function reply(
  body: string,
  tabTitle = "Sheet1",
): { status: number; text: string } {
  const request = JSON.parse(body) as {
    action: string;
    valueRenderOption?: string;
    ranges?: string[];
  };
  if (request.action === "spreadsheets/get") {
    return json({
      sheets: [{
        properties: {
          ...SHEET_META.sheets[0].properties,
          title: tabTitle,
        },
      }],
    });
  }
  const formula = request.valueRenderOption === "FORMULA";
  return json({
    valueRanges: [{
      range: request.ranges?.[0] ?? "",
      values: [["привет", 42], ["", formula ? "=B1*2" : 84]],
    }],
  });
}

function json(result: unknown): { status: number; text: string } {
  return { status: 200, text: JSON.stringify({ success: true, result }) };
}

/** Окружение подкоманды: кэш-БД, env-файл и подставной канал webapp. */
function harness(
  db: CacheDb,
  env: Readonly<Record<string, string>> = {},
  tabTitle = "Sheet1",
) {
  const requests: string[] = [];
  const post = (_url: string, body: string) => {
    requests.push(body);
    return Promise.resolve(reply(body, tabTitle));
  };
  const notes: string[] = [];
  const io = makeFakeIo({
    envFile: {
      get: (name: string) =>
        ({ WB_PLUS_WEB_APP_URL: "https://script.example/exec", ...env })[name],
      require: (name: string) => {
        const value =
          ({ WB_PLUS_WEB_APP_URL: "https://script.example/exec", ...env })[
            name
          ];
        if (value === undefined) throw new DomainError(`нет ключа ${name}`);
        return value;
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({ ...env }),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    readTextFile: (path: string) => {
      throw new NotFoundIoError(`нет файла ${path}`);
    },
    note: (line: string) => void notes.push(line),
  });
  return { io, requests, notes, options: { post } };
}

/** Кэш-БД во временном каталоге; таблицы созданы bootstrap'ом. */
async function withDb(body: (db: CacheDb) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const getArgs = (overrides: Record<string, unknown> = {}) => ({
  ranges: ["Sheet1!A1:B2"],
  spreadsheet: SS_ID,
  sheet: undefined,
  from: undefined,
  render: "both",
  raw: false,
  tsv: false,
  refresh: false,
  ...overrides,
});

const lsArgs = (overrides: Record<string, unknown> = {}) => ({
  spreadsheet: SS_ID,
  long: false,
  json: false,
  refresh: false,
  ...overrides,
});

Deno.test("resolve: JSON цели — эталон канала, сети нет", async () => {
  await withDb(async (db) => {
    const { io } = harness(db);
    const result = await sheetResolveCommand.invokeInput(
      { spreadsheet: SS_ID },
      io,
    );
    assertEquals(
      sheetResolveCommand.renderResult(result, ["-s", SS_ID]),
      await golden("resolve.stdout"),
    );
  });
});

Deno.test("resolve: цель из конфига, когда флага нет", async () => {
  await withDb(async (db) => {
    const io = makeFakeIo({
      envFile: {
        get: () => undefined,
        require: () => "",
        set: () => Promise.resolve(),
        values: () => ({}),
      },
      openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
      note: () => {},
    });
    // Ровно то, что пишет `mpu config sheet.default <id>`: строка в
    // таблице `config` той же кэш-БД (`platform/config.md`).
    setConfigValue(db, "sheet.default", SS_ID);
    const result = await sheetResolveCommand.invokeInput(
      { spreadsheet: undefined },
      io,
    ) as { ss_id: string; source: string };
    // Источник конфига — единственный, кроме флага: сломай его чтение,
    // и у команды не останется ни одного (`sheet.md`, «CLI-контракт»).
    assertEquals(result.source, "config");
    assertEquals(result.ss_id, SS_ID);
  });
});

Deno.test("ls: три формы вывода — эталоны канала", async (t) => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const run = (args: Record<string, unknown>) =>
      runLs(lsArgs(args) as Parameters<typeof runLs>[0], io, options);

    await t.step("-l", async () => {
      const result = await run({ long: true });
      assertEquals(
        sheetLsCommand.renderResult(result, ["-l"]),
        await golden("ls-long.stdout"),
      );
    });

    await t.step("--json", async () => {
      const result = await run({ json: true });
      assertEquals(
        sheetLsCommand.renderResult(result, ["--json"]),
        await golden("ls-json.stdout"),
      );
    });

    await t.step("-l вместе с --json: побеждает --json", async () => {
      const result = await run({ long: true, json: true });
      assertEquals(
        sheetLsCommand.renderResult(result, ["-l", "--json"]),
        await golden("ls-long-json.stdout"),
      );
    });

    await t.step("умолчание — только заголовки", async () => {
      const result = await run({});
      assertEquals(sheetLsCommand.renderResult(result, []), "Sheet1\n");
    });
  });
});

Deno.test("get: JSON, raw и tsv — эталоны канала", async (t) => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const run = (args: Record<string, unknown> = {}) =>
      runGet(getArgs(args) as Parameters<typeof runGet>[0], io, options);

    await t.step("первый вызов читает webapp, второй — кэш", async () => {
      const first = await run() as { valueRanges: { fromCache: boolean }[] };
      assertEquals(first.valueRanges[0].fromCache, false);
      const second = await run();
      assertEquals(
        sheetGetCommand.renderResult(second, ["Sheet1!A1:B2"]),
        await golden("get-both-cached.stdout"),
      );
    });

    await t.step("--raw: один слой без обвязки", async () => {
      const result = await run({ raw: true });
      assertEquals(
        sheetGetCommand.renderResult(result, ["--raw"]),
        await golden("get-raw.stdout"),
      );
    });

    await t.step("--tsv", async () => {
      const result = await run({ tsv: true });
      assertEquals(
        sheetGetCommand.renderResult(result, ["--tsv"]),
        await golden("get-tsv.stdout"),
      );
    });

    await t.step("--raw одной ячейки — без финального перевода", async () => {
      // Единственная строка единственного диапазона без табуляции идёт
      // без `\n`: её вставляют в другую команду (спека, «--raw»).
      const result = await run({ ranges: ["Sheet1!A1"], raw: true });
      assertEquals(
        sheetGetCommand.renderResult(result, ["Sheet1!A1", "--raw"]),
        "привет",
      );
    });

    await t.step("--tsv той же ячейки — перевод строки есть", async () => {
      const result = await run({ ranges: ["Sheet1!A1"], tsv: true });
      assertEquals(
        sheetGetCommand.renderResult(result, ["Sheet1!A1", "--tsv"]),
        "привет\n",
      );
    });

    await t.step("--raw вместе с --tsv: побеждает --tsv", async () => {
      const result = await run({ raw: true, tsv: true });
      assertEquals(
        sheetGetCommand.renderResult(result, ["--raw", "--tsv"]),
        await golden("get-tsv.stdout"),
      );
    });
  });
});

Deno.test("get: слои кладутся ровно по --render", async (t) => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const layersOf = async (render: string) => {
      const result = await runGet(
        getArgs({ render }),
        io,
        options,
      ) as unknown as { valueRanges: Record<string, unknown>[] };
      return Object.keys(result.valueRanges[0]);
    };

    await t.step("both — оба слоя", async () => {
      assertEquals(await layersOf("both"), [
        "range",
        "values",
        "formulas",
        "fromCache",
      ]);
    });

    await t.step("values — только значения", async () => {
      assertEquals(await layersOf("values"), ["range", "values", "fromCache"]);
    });

    await t.step("formulas — только формулы", async () => {
      assertEquals(await layersOf("formulas"), [
        "range",
        "formulas",
        "fromCache",
      ]);
    });

    await t.step("formatted — свой слой и мимо кэша", async () => {
      const result = await runGet(
        getArgs({ render: "formatted" }),
        io,
        options,
      );
      assertEquals(Object.keys(result.valueRanges[0]), [
        "range",
        "formatted",
        "fromCache",
      ]);
      // Locale-зависимый слой не кэшируется никогда (атом).
      assertEquals(result.valueRanges[0].fromCache, false);
    });
  });
});

Deno.test("get: порядок ответов повторяет порядок ввода", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const result = await runGet(
      getArgs({ ranges: ["Sheet1!B1:B2", "Sheet1!A1:A2"] }),
      io,
      options,
    );
    assertEquals(result.valueRanges.map((item) => item.range), [
      "Sheet1!B1:B2",
      "Sheet1!A1:A2",
    ]);
  });
});

Deno.test("get: отказы ввода — до сети", async (t) => {
  await withDb(async (db) => {
    const { io, options } = harness(db);

    await t.step("нет диапазонов", async () => {
      const err = await assertRejects(
        () => runGet(getArgs({ ranges: [] }), io, options),
        UsageError,
      );
      // Голден сверяется как есть: форма использования печатается без
      // префикса команды, и дописывать его к эталону значило бы
      // подгонять эталон под код.
      assertEquals(
        `${formatCommandError("sheet", err)}\n`,
        await golden("err-no-ranges.stderr"),
      );
    });

    await t.step("незнакомый --render", async () => {
      const err = await assertRejects(
        () => runGet(getArgs({ render: "raw" }), io, options),
        UsageError,
      );
      assertEquals(
        err.message,
        "--render must be one of: both, values, formulas, formatted",
      );
    });

    await t.step("диапазон без листа", async () => {
      const err = await assertRejects(
        () => runGet(getArgs({ ranges: ["A1:B2"] }), io, options),
        UsageError,
      );
      assertStringIncludes(err.message, "диапазон 'A1:B2' без имени листа");
    });

    await t.step("невалидный диапазон", async () => {
      await assertRejects(
        () => runGet(getArgs({ ranges: ["Sheet1!A1:"] }), io, options),
        UsageError,
        "невалидный диапазон 'Sheet1!A1:'",
      );
    });

    await t.step("--from с несуществующим файлом", async () => {
      await assertRejects(
        () =>
          sheetGetCommand.invokeInput(
            getArgs({ ranges: [], from: "/нет/такого" }),
            io,
          ),
        UsageError,
        "файл '/нет/такого' не найден",
      );
    });
  });
});

Deno.test("get: --sheet префиксует и означает весь лист", async (t) => {
  await withDb(async (db) => {
    const { io, options } = harness(db);

    await t.step("префикс для диапазона без листа", async () => {
      const result = await runGet(
        getArgs({ ranges: ["A1:B2"], sheet: "Sheet1" }),
        io,
        options,
      ) as { valueRanges: { range: string }[] };
      assertEquals(result.valueRanges[0].range, "Sheet1!A1:B2");
    });

    await t.step("без диапазонов — весь лист", async () => {
      const result = await runGet(
        getArgs({ ranges: [], sheet: "Sheet1" }),
        io,
        options,
      ) as { valueRanges: { range: string }[] };
      // Закрытая форма по фактическим границам листа.
      assertEquals(result.valueRanges[0].range, "Sheet1!A1:Z1000");
    });
  });
});

Deno.test("get: имя листа кавычится и в адресе всего листа", async () => {
  await withDb(async (db) => {
    const { io, options, requests } = harness(db, {}, "Мой лист");
    await runGet(getArgs({ ranges: [], sheet: "Мой лист" }), io, options);
    const whole = requests
      .map((body) => JSON.parse(body) as { ranges?: string[] })
      .flatMap((request) => request.ranges ?? []);
    // Без кавычек Sheets API такой диапазон не разберёт (атом).
    assertEquals(whole, ["'Мой лист'!A1:Z1000", "'Мой лист'!A1:Z1000"]);
  });
});

Deno.test("get: лист не найден — отказ с перечнем доступных", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const err = await assertRejects(
      () => runGet(getArgs({ ranges: ["Нет!A1"] }), io, options),
      DomainError,
    );
    assertEquals(
      err.message,
      `лист 'Нет' не найден в spreadsheet ${SS_ID}; доступные: Sheet1`,
    );
  });
});

Deno.test("get: --refresh не читает кэш, но перезаписывает", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    await runGet(getArgs(), io, options);
    const refreshed = await runGet(getArgs({ refresh: true }), io, options);
    assertEquals(refreshed.valueRanges[0].fromCache, false);
    // После обновления кэш снова жив: следующий вызов читает его.
    const next = await runGet(getArgs(), io, options) as {
      valueRanges: { fromCache: boolean }[];
    };
    assertEquals(next.valueRanges[0].fromCache, true);
  });
});

Deno.test("WB_PLUS_WEB_APP_URL не задан — доменный отказ", async () => {
  await withDb(async (db) => {
    const io = makeFakeIo({
      envFile: {
        get: () => undefined,
        require: (name: string) => {
          throw new DomainError(
            `environment variable ${name} is not set. Add it to ` +
              "/home/проба/.config/mpu/.env or export in shell.",
          );
        },
        set: () => Promise.reject(new Error("не ожидается")),
        values: () => ({}),
      },
      openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
      note: () => {},
    });
    const err = await assertRejects(
      () => runLs(lsArgs() as Parameters<typeof runLs>[0], io),
      DomainError,
    );
    assertStringIncludes(err.message, "WB_PLUS_WEB_APP_URL");
  });
});

Deno.test("кэш листа живёт по sheet.cache.tab_ttl из предпочтений", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const at = (nowSeconds: number) => ({ ...options, nowSeconds });
    await runGet(getArgs(), io, at(1000));
    // Умолчание TTL — 7200 с: через час запись ещё жива.
    const warm = await runGet(getArgs(), io, at(1000 + 3600)) as {
      valueRanges: { fromCache: boolean }[];
    };
    assertEquals(warm.valueRanges[0].fromCache, true);
    // Ровно то, что пишет `mpu config sheet.cache.tab_ttl 60`. Ключ,
    // записанный в таблицу `config`, обязан менять поведение кэша:
    // иначе «молча на умолчаниях» вернётся другой дорогой
    // (`platform/config.md`, инвариант о немедленной видимости).
    setConfigValue(db, "sheet.cache.tab_ttl", "60");
    const cold = await runGet(getArgs(), io, at(1000 + 3600)) as {
      valueRanges: { fromCache: boolean }[];
    };
    assertEquals(cold.valueRanges[0].fromCache, false);
  });
});
