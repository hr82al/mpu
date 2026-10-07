/**
 * Подкоманды `mpu sheet` (`docs/specs/sheet.md`): формы вывода против
 * эталонов канала, кэш листов и отказы ввода.
 *
 * Живого webapp здесь нет: канал подставной, а кэш-БД настоящая — она
 * и есть то, что отличает первый вызов от повторного.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import {
  type CacheDb,
  type CommandIo,
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
  sheets: [
    {
      properties: {
        title: "Sheet1",
        sheetId: 0,
        index: 0,
        gridProperties: { rowCount: 1000, columnCount: 26 },
      },
    },
  ],
};

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/sheet/${name}`, import.meta.url),
    "utf8",
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
      sheets: [
        {
          properties: {
            ...SHEET_META.sheets[0].properties,
            title: tabTitle,
          },
        },
      ],
    });
  }
  const formula = request.valueRenderOption === "FORMULA";
  return json({
    valueRanges: [
      {
        range: request.ranges?.[0] ?? "",
        values: [
          ["привет", 42],
          ["", formula ? "=B1*2" : 84],
        ],
      },
    ],
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
        const value = {
          WB_PLUS_WEB_APP_URL: "https://script.example/exec",
          ...env,
        }[name];
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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
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

it("resolve: JSON цели — эталон канала, сети нет", async () => {
  await withDb(async (db) => {
    const { io } = harness(db);
    const result = await sheetResolveCommand.invokeInput(
      { spreadsheet: SS_ID },
      io,
    );
    expect(
      sheetResolveCommand.renderResult(result, ["-s", SS_ID]),
    ).toStrictEqual(await golden("resolve.stdout"));
  });
});

it("resolve: цель из конфига, когда флага нет", async () => {
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
    const result = (await sheetResolveCommand.invokeInput(
      { spreadsheet: undefined },
      io,
    )) as { ss_id: string; source: string };
    // Источник конфига — единственный, кроме флага: сломай его чтение,
    // и у команды не останется ни одного (`sheet.md`, «CLI-контракт»).
    expect(result.source).toBe("config");
    expect(result.ss_id).toStrictEqual(SS_ID);
  });
});

/**
 * Кэш-БД на весь `describe`: открыта до первого случая, закрыта и стёрта
 * после последнего; `use` получает открытую. Не открылась — закрывать
 * нечего, и `afterAll` не заслоняет причину своим отказом.
 */
function suiteDb(use: (db: CacheDb) => void): void {
  let dir: string | undefined;
  let opened: CacheDb | undefined;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpu-"));
    opened = openCacheDb(`${dir}/mpu.db`);
    opened.bootstrap();
    use(opened);
  });
  afterAll(async () => {
    opened?.[Symbol.dispose]();
    if (dir !== undefined) await rm(dir, { recursive: true });
  });
}

describe("ls: три формы вывода — эталоны канала", () => {
  let io: CommandIo;
  let options: ReturnType<typeof harness>["options"];
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(() => {
    ({ io, options } = harness(db));
  });
  const run = (args: Record<string, unknown>) =>
    runLs(lsArgs(args) as Parameters<typeof runLs>[0], io, options);

  it("-l", async () => {
    const result = await run({ long: true });
    expect(sheetLsCommand.renderResult(result, ["-l"])).toStrictEqual(
      await golden("ls-long.stdout"),
    );
  });

  it("--json", async () => {
    const result = await run({ json: true });
    expect(sheetLsCommand.renderResult(result, ["--json"])).toStrictEqual(
      await golden("ls-json.stdout"),
    );
  });

  it("-l вместе с --json: побеждает --json", async () => {
    const result = await run({ long: true, json: true });
    expect(sheetLsCommand.renderResult(result, ["-l", "--json"])).toStrictEqual(
      await golden("ls-long-json.stdout"),
    );
  });

  it("умолчание — только заголовки", async () => {
    const result = await run({});
    expect(sheetLsCommand.renderResult(result, [])).toBe("Sheet1\n");
  });
});

describe("get: JSON, raw и tsv — эталоны канала", () => {
  let io: CommandIo;
  let options: ReturnType<typeof harness>["options"];
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(() => {
    ({ io, options } = harness(db));
  });
  const run = (args: Record<string, unknown> = {}) =>
    runGet(getArgs(args) as Parameters<typeof runGet>[0], io, options);

  it("первый вызов читает webapp, второй — кэш", async () => {
    const first = (await run()) as { valueRanges: { fromCache: boolean }[] };
    expect(first.valueRanges[0].fromCache).toBe(false);
    const second = await run();
    expect(
      sheetGetCommand.renderResult(second, ["Sheet1!A1:B2"]),
    ).toStrictEqual(await golden("get-both-cached.stdout"));
  });

  it("--raw: один слой без обвязки", async () => {
    const result = await run({ raw: true });
    expect(sheetGetCommand.renderResult(result, ["--raw"])).toStrictEqual(
      await golden("get-raw.stdout"),
    );
  });

  it("--tsv", async () => {
    const result = await run({ tsv: true });
    expect(sheetGetCommand.renderResult(result, ["--tsv"])).toStrictEqual(
      await golden("get-tsv.stdout"),
    );
  });

  it("--raw одной ячейки — без финального перевода", async () => {
    // Единственная строка единственного диапазона без табуляции идёт
    // без `\n`: её вставляют в другую команду (спека, «--raw»).
    const result = await run({ ranges: ["Sheet1!A1"], raw: true });
    expect(sheetGetCommand.renderResult(result, ["Sheet1!A1", "--raw"])).toBe(
      "привет",
    );
  });

  it("--tsv той же ячейки — перевод строки есть", async () => {
    const result = await run({ ranges: ["Sheet1!A1"], tsv: true });
    expect(sheetGetCommand.renderResult(result, ["Sheet1!A1", "--tsv"])).toBe(
      "привет\n",
    );
  });

  it("--raw вместе с --tsv: побеждает --tsv", async () => {
    const result = await run({ raw: true, tsv: true });
    expect(
      sheetGetCommand.renderResult(result, ["--raw", "--tsv"]),
    ).toStrictEqual(await golden("get-tsv.stdout"));
  });
});

describe("get: слои кладутся ровно по --render", () => {
  let io: CommandIo;
  let options: ReturnType<typeof harness>["options"];
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(() => {
    ({ io, options } = harness(db));
  });
  const layersOf = async (render: string) => {
    const result = (await runGet(
      getArgs({ render }),
      io,
      options,
    )) as unknown as { valueRanges: Record<string, unknown>[] };
    return Object.keys(result.valueRanges[0]);
  };

  it("both — оба слоя", async () => {
    expect(await layersOf("both")).toStrictEqual([
      "range",
      "values",
      "formulas",
      "fromCache",
    ]);
  });

  it("values — только значения", async () => {
    expect(await layersOf("values")).toStrictEqual([
      "range",
      "values",
      "fromCache",
    ]);
  });

  it("formulas — только формулы", async () => {
    expect(await layersOf("formulas")).toStrictEqual([
      "range",
      "formulas",
      "fromCache",
    ]);
  });

  it("formatted — свой слой и мимо кэша", async () => {
    const result = await runGet(getArgs({ render: "formatted" }), io, options);
    expect(Object.keys(result.valueRanges[0])).toStrictEqual([
      "range",
      "formatted",
      "fromCache",
    ]);
    // Locale-зависимый слой не кэшируется никогда (атом).
    expect(result.valueRanges[0].fromCache).toBe(false);
  });
});

it("get: порядок ответов повторяет порядок ввода", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const result = await runGet(
      getArgs({ ranges: ["Sheet1!B1:B2", "Sheet1!A1:A2"] }),
      io,
      options,
    );
    expect(result.valueRanges.map((item) => item.range)).toStrictEqual([
      "Sheet1!B1:B2",
      "Sheet1!A1:A2",
    ]);
  });
});

describe("get: отказы ввода — до сети", () => {
  let io: CommandIo;
  let options: ReturnType<typeof harness>["options"];
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(() => {
    ({ io, options } = harness(db));
  });

  it("нет диапазонов", async () => {
    const err = await rejected(
      () => runGet(getArgs({ ranges: [] }), io, options),
      UsageError,
    );
    // Голден сверяется как есть: форма использования печатается без
    // префикса команды, и дописывать его к эталону значило бы
    // подгонять эталон под код.
    expect(`${formatCommandError("sheet", err)}\n`).toStrictEqual(
      await golden("err-no-ranges.stderr"),
    );
  });

  it("незнакомый --render", async () => {
    const err = await rejected(
      () => runGet(getArgs({ render: "raw" }), io, options),
      UsageError,
    );
    expect(err.message).toBe(
      "--render must be one of: both, values, formulas, formatted",
    );
  });

  it("диапазон без листа", async () => {
    const err = await rejected(
      () => runGet(getArgs({ ranges: ["A1:B2"] }), io, options),
      UsageError,
    );
    expect(err.message).toContain("диапазон 'A1:B2' без имени листа");
  });

  it("невалидный диапазон", async () => {
    const failure = runGet(getArgs({ ranges: ["Sheet1!A1:"] }), io, options);
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow("невалидный диапазон 'Sheet1!A1:'");
  });

  it("--from с несуществующим файлом", async () => {
    const failure = sheetGetCommand.invokeInput(
      getArgs({ ranges: [], from: "/нет/такого" }),
      io,
    );
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow("файл '/нет/такого' не найден");
  });
});

describe("get: --sheet префиксует и означает весь лист", () => {
  let io: CommandIo;
  let options: ReturnType<typeof harness>["options"];
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(() => {
    ({ io, options } = harness(db));
  });

  it("префикс для диапазона без листа", async () => {
    const result = (await runGet(
      getArgs({ ranges: ["A1:B2"], sheet: "Sheet1" }),
      io,
      options,
    )) as { valueRanges: { range: string }[] };
    expect(result.valueRanges[0].range).toBe("Sheet1!A1:B2");
  });

  it("без диапазонов — весь лист", async () => {
    const result = (await runGet(
      getArgs({ ranges: [], sheet: "Sheet1" }),
      io,
      options,
    )) as { valueRanges: { range: string }[] };
    // Закрытая форма по фактическим границам листа.
    expect(result.valueRanges[0].range).toBe("Sheet1!A1:Z1000");
  });
});

it("get: имя листа кавычится и в адресе всего листа", async () => {
  await withDb(async (db) => {
    const { io, options, requests } = harness(db, {}, "Мой лист");
    await runGet(getArgs({ ranges: [], sheet: "Мой лист" }), io, options);
    const whole = requests
      .map((body) => JSON.parse(body) as { ranges?: string[] })
      .flatMap((request) => request.ranges ?? []);
    // Без кавычек Sheets API такой диапазон не разберёт (атом).
    expect(whole).toStrictEqual(["'Мой лист'!A1:Z1000", "'Мой лист'!A1:Z1000"]);
  });
});

it("get: лист не найден — отказ с перечнем доступных", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const err = await rejected(
      () => runGet(getArgs({ ranges: ["Нет!A1"] }), io, options),
      DomainError,
    );
    expect(err.message).toStrictEqual(
      `лист 'Нет' не найден в spreadsheet ${SS_ID}; доступные: Sheet1`,
    );
  });
});

it("get: --refresh не читает кэш, но перезаписывает", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    await runGet(getArgs(), io, options);
    const refreshed = await runGet(getArgs({ refresh: true }), io, options);
    expect(refreshed.valueRanges[0].fromCache).toBe(false);
    // После обновления кэш снова жив: следующий вызов читает его.
    const next = (await runGet(getArgs(), io, options)) as {
      valueRanges: { fromCache: boolean }[];
    };
    expect(next.valueRanges[0].fromCache).toBe(true);
  });
});

it("WB_PLUS_WEB_APP_URL не задан — доменный отказ", async () => {
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
    const err = await rejected(
      () => runLs(lsArgs() as Parameters<typeof runLs>[0], io),
      DomainError,
    );
    expect(err.message).toContain("WB_PLUS_WEB_APP_URL");
  });
});

it("кэш листа живёт по sheet.cache.tab_ttl из предпочтений", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const at = (nowSeconds: number) => ({ ...options, nowSeconds });
    await runGet(getArgs(), io, at(1000));
    // Умолчание TTL — 7200 с: через час запись ещё жива.
    const warm = (await runGet(getArgs(), io, at(1000 + 3600))) as {
      valueRanges: { fromCache: boolean }[];
    };
    expect(warm.valueRanges[0].fromCache).toBe(true);
    // Ровно то, что пишет `mpu config sheet.cache.tab_ttl 60`. Ключ,
    // записанный в таблицу `config`, обязан менять поведение кэша:
    // иначе «молча на умолчаниях» вернётся другой дорогой
    // (`platform/config.md`, инвариант о немедленной видимости).
    setConfigValue(db, "sheet.cache.tab_ttl", "60");
    const cold = (await runGet(getArgs(), io, at(1000 + 3600))) as {
      valueRanges: { fromCache: boolean }[];
    };
    expect(cold.valueRanges[0].fromCache).toBe(false);
  });
});
