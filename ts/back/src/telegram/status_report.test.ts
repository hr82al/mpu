import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type CardMove,
  cutToLimit,
  type ReportStyle,
  reportStyle,
  reportText,
} from "./status_report.ts";

/** День голденов: он приходит в отчёт готовым, а не из стенных часов. */
const DAY = "2026-08-17";

const EMPTY_STYLE: ReportStyle = { columnMap: {}, emoji: {} };

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-status/${name}`, import.meta.url),
    "utf8",
  );
}

const MOVES: readonly CardMove[] = [
  {
    cardId: 70000001,
    title: "Починить выгрузку остатков",
    url: "https://kaiten.example/70000001",
    column: "Готово",
    movedAt: Math.trunc(Date.parse("2026-08-17T06:40:00.000Z") / 1000),
  },
  {
    cardId: 70000002,
    title: "Отчёт по марже [черновик]",
    url: "https://kaiten.example/70000002",
    column: "Код-ревью",
    movedAt: Math.trunc(Date.parse("2026-08-17T06:20:00.000Z") / 1000),
  },
  {
    cardId: 70000003,
    title: null,
    url: "https://kaiten.example/70000003",
    column: "4210",
    movedAt: Math.trunc(Date.parse("2026-08-17T06:00:00.000Z") / 1000),
  },
];

it("отчёт с записями совпадает с голденом", async () => {
  expect(`${reportText(MOVES, DAY, EMPTY_STYLE)}\n`).toStrictEqual(
    await golden("status-report-stdout.txt"),
  );
});

it("записей нет — отчёт говорит об этом, а не пустует", async () => {
  expect(`${reportText([], DAY, EMPTY_STYLE)}\n`).toStrictEqual(
    await golden("status-empty-stdout.txt"),
  );
});

it("дедуп по карточке: побеждает наибольший момент", () => {
  const early: CardMove = { ...MOVES[0], column: "Разработка", movedAt: 1 };
  const late: CardMove = { ...MOVES[0], column: "Готово", movedAt: 2 };
  for (const order of [[early, late], [late, early]]) {
    const lines = reportText(order, DAY, EMPTY_STYLE).split("\n");
    expect(lines.length).toBe(3);
    expect(lines[2].endsWith("— Готово ✅")).toBe(true);
  }
});

it("порядок — по моменту и id карточки, по убыванию", () => {
  const at = (cardId: number, movedAt: number): CardMove => ({
    ...MOVES[0],
    cardId,
    title: `карточка ${cardId}`,
    movedAt,
  });
  const lines = reportText(
    [at(1, 100), at(3, 200), at(2, 200)],
    DAY,
    EMPTY_STYLE,
  ).split("\n").slice(2);
  expect(lines.map((line) => line.slice(0, 14))).toStrictEqual([
    "1. [карточка 3",
    "2. [карточка 2",
    "3. [карточка 1",
  ]);
});

describe("эмодзи по имени колонки", () => {
  const cases: readonly [string, string][] = [
    ["Готово", "✅"],
    ["выполнено", "✅"],
    ["Код-ревью", "👀"],
    ["Тестирование", "🧪"],
    ["В разработке", "🛠️"],
    ["Выгрузка", "🚀"],
    ["DEV", "🚀"],
    ["prod", "🚀"],
    ["Очередь", "📋"],
    ["Оценка", "📊"],
    ["Багфикс", "🐞"],
    ["4210", "🔹"],
    ["Готово к выгрузке", "🚀"],
  ];
  for (const [column, emoji] of cases) {
    it(column, () => {
      const line = reportText(
        [{ ...MOVES[0], column }],
        DAY,
        EMPTY_STYLE,
      ).split("\n")[2];
      expect(line.endsWith(`— ${column} ${emoji}`), line).toBe(true);
    });
  }
});

it("замена имени колонки идёт раньше выбора эмодзи", () => {
  const line = reportText([{ ...MOVES[0], column: "col-42" }], DAY, {
    columnMap: { "col-42": "Ревью" },
    emoji: {},
  }).split("\n")[2];
  expect(line.endsWith("— Ревью 👀"), line).toBe(true);
});

it("переопределение эмодзи старше правил, регистр не важен", () => {
  const line = reportText([{ ...MOVES[0], column: "Готово" }], DAY, {
    columnMap: {},
    emoji: { "готово": "🎉" },
  }).split("\n")[2];
  expect(line.endsWith("— Готово 🎉"), line).toBe(true);
});

it("переопределение эмодзи опознаётся по ключу, а не по отличию", () => {
  const line = reportText([{ ...MOVES[0], column: "Готово" }], DAY, {
    columnMap: {},
    emoji: { "Готово": "Готово" },
  }).split("\n")[2];
  // Правило 1 старше «готово → ✅», даже когда значение равно имени.
  expect(line.endsWith("— Готово Готово"), line).toBe(true);
});

it("скобки заголовка становятся полноширинными", () => {
  const line = reportText(
    [{ ...MOVES[0], title: "[a] [b]" }],
    DAY,
    EMPTY_STYLE,
  ).split("\n")[2];
  expect(line.startsWith("1. [［a］ ［b］]("), line).toBe(true);
});

describe("усечение режет по границе целых строк", () => {
  const line = `1. [${"я".repeat(40)}](https://kaiten.example/1) — Готово ✅`;
  const text = `шапка\n\n${[line, line, line].join("\n")}`;
  it("короткий текст не трогается", () => {
    expect(cutToLimit(text, 4096)).toStrictEqual(text);
  });
  it("длинный обрезается целыми строками с маркером", () => {
    const cut = cutToLimit(text, text.length - 1);
    expect(cut.endsWith("\n…(обрезано)")).toBe(true);
    expect(cut.length <= text.length - 1).toBe(true);
    // Половин строк не остаётся: маркер идёт после целой строки.
    expect(cut.slice(0, -"\n…(обрезано)".length).split("\n")).toStrictEqual([
      "шапка",
      "",
      line,
      line,
    ]);
  });
  it("не влезает ни одна строка — остаётся один маркер", () => {
    expect(cutToLimit(text, 12)).toBe("…(обрезано)");
  });
  it("маркер не влезает и сам — не выходит за предел", () => {
    // Предел меньше маркера недостижим при 4096, но обещание функции
    // «уложиться в предел» не знает исключений.
    for (const limit of [0, 5, 10]) {
      expect(cutToLimit(text, limit)).toBe("");
    }
  });
});

describe("стиль отчёта из env-файла", () => {
  it("объекты разбираются", () => {
    expect(reportStyle({
      columns: '{"col-42": "Ревью"}',
      emoji: '{"Готово": "🎉"}',
    })).toStrictEqual({
      columnMap: { "col-42": "Ревью" },
      emoji: { "Готово": "🎉" },
    });
  });
  for (
    const raw of [undefined, "", "  ", "не json", "[1,2]", '"строка"', "null"]
  ) {
    it(`переопределений нет: ${String(raw)}`, () => {
      expect(reportStyle({ columns: raw, emoji: raw })).toStrictEqual({
        columnMap: {},
        emoji: {},
      });
    });
  }
  it("нестроковые значения отбрасываются", () => {
    expect(
      reportStyle({ columns: '{"a": 1, "b": "Готово"}', emoji: undefined }),
    ).toStrictEqual({ columnMap: { b: "Готово" }, emoji: {} });
  });
});

describe("предел меряется кодовыми единицами UTF-16", () => {
  // Эмодзи вне основной плоскости: кодовых точек 10, кодовых единиц 20 —
  // счёт точками выпустил бы сообщение длиннее предела, и отказ пришёл
  // бы уже от Telegram (`telegram-status.md`, «Отправка»).
  const line = "🚀".repeat(10);
  const text = `${line}\n${line}`;
  it("текст длиннее предела в единицах — усекается", () => {
    const cut = cutToLimit(text, 33);
    expect(cut).toStrictEqual(`${line}\n…(обрезано)`);
    expect(cut.length <= 33, `${cut.length} единиц`).toBe(true);
  });
  it("текст короче предела — не трогается", () => {
    expect(cutToLimit(text, text.length)).toStrictEqual(text);
  });
});
