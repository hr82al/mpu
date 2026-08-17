import { assertEquals } from "@std/assert";
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
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-status/${name}`, import.meta.url),
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

Deno.test("отчёт с записями совпадает с голденом", async () => {
  assertEquals(
    `${reportText(MOVES, DAY, EMPTY_STYLE)}\n`,
    await golden("status-report-stdout.txt"),
  );
});

Deno.test("записей нет — отчёт говорит об этом, а не пустует", async () => {
  assertEquals(
    `${reportText([], DAY, EMPTY_STYLE)}\n`,
    await golden("status-empty-stdout.txt"),
  );
});

Deno.test("дедуп по карточке: побеждает наибольший момент", () => {
  const early: CardMove = { ...MOVES[0], column: "Разработка", movedAt: 1 };
  const late: CardMove = { ...MOVES[0], column: "Готово", movedAt: 2 };
  for (const order of [[early, late], [late, early]]) {
    const lines = reportText(order, DAY, EMPTY_STYLE).split("\n");
    assertEquals(lines.length, 3);
    assertEquals(lines[2].endsWith("— Готово ✅"), true);
  }
});

Deno.test("порядок — по моменту и id карточки, по убыванию", () => {
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
  assertEquals(
    lines.map((line) => line.slice(0, 14)),
    ["1. [карточка 3", "2. [карточка 2", "3. [карточка 1"],
  );
});

Deno.test("эмодзи по имени колонки", async (t) => {
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
    await t.step(column, () => {
      const line = reportText(
        [{ ...MOVES[0], column }],
        DAY,
        EMPTY_STYLE,
      ).split("\n")[2];
      assertEquals(line.endsWith(`— ${column} ${emoji}`), true, line);
    });
  }
});

Deno.test("замена имени колонки идёт раньше выбора эмодзи", () => {
  const line = reportText([{ ...MOVES[0], column: "col-42" }], DAY, {
    columnMap: { "col-42": "Ревью" },
    emoji: {},
  }).split("\n")[2];
  assertEquals(line.endsWith("— Ревью 👀"), true, line);
});

Deno.test("переопределение эмодзи старше правил, регистр не важен", () => {
  const line = reportText([{ ...MOVES[0], column: "Готово" }], DAY, {
    columnMap: {},
    emoji: { "готово": "🎉" },
  }).split("\n")[2];
  assertEquals(line.endsWith("— Готово 🎉"), true, line);
});

Deno.test("переопределение эмодзи опознаётся по ключу, а не по отличию", () => {
  const line = reportText([{ ...MOVES[0], column: "Готово" }], DAY, {
    columnMap: {},
    emoji: { "Готово": "Готово" },
  }).split("\n")[2];
  // Правило 1 старше «готово → ✅», даже когда значение равно имени.
  assertEquals(line.endsWith("— Готово Готово"), true, line);
});

Deno.test("скобки заголовка становятся полноширинными", () => {
  const line = reportText(
    [{ ...MOVES[0], title: "[a] [b]" }],
    DAY,
    EMPTY_STYLE,
  ).split("\n")[2];
  assertEquals(line.startsWith("1. [［a］ ［b］]("), true, line);
});

Deno.test("усечение режет по границе целых строк", async (t) => {
  const line = `1. [${"я".repeat(40)}](https://kaiten.example/1) — Готово ✅`;
  const text = `шапка\n\n${[line, line, line].join("\n")}`;
  await t.step("короткий текст не трогается", () => {
    assertEquals(cutToLimit(text, 4096), text);
  });
  await t.step("длинный обрезается целыми строками с маркером", () => {
    const cut = cutToLimit(text, text.length - 1);
    assertEquals(cut.endsWith("\n…(обрезано)"), true);
    assertEquals([...cut].length <= text.length - 1, true);
    // Половин строк не остаётся: маркер идёт после целой строки.
    assertEquals(
      cut.slice(0, -"\n…(обрезано)".length).split("\n"),
      ["шапка", "", line, line],
    );
  });
  await t.step("не влезает ни одна строка — остаётся один маркер", () => {
    assertEquals(cutToLimit(text, 12), "…(обрезано)");
  });
});

Deno.test("стиль отчёта из env-файла", async (t) => {
  await t.step("объекты разбираются", () => {
    assertEquals(
      reportStyle({
        columns: '{"col-42": "Ревью"}',
        emoji: '{"Готово": "🎉"}',
      }),
      { columnMap: { "col-42": "Ревью" }, emoji: { "Готово": "🎉" } },
    );
  });
  for (
    const raw of [undefined, "", "  ", "не json", "[1,2]", '"строка"', "null"]
  ) {
    await t.step(`переопределений нет: ${String(raw)}`, () => {
      assertEquals(reportStyle({ columns: raw, emoji: raw }), {
        columnMap: {},
        emoji: {},
      });
    });
  }
  await t.step("нестроковые значения отбрасываются", () => {
    assertEquals(
      reportStyle({ columns: '{"a": 1, "b": "Готово"}', emoji: undefined }),
      { columnMap: { b: "Готово" }, emoji: {} },
    );
  });
});

Deno.test("предел меряется кодовыми единицами UTF-16", async (t) => {
  // Эмодзи вне основной плоскости: кодовых точек 10, кодовых единиц 20 —
  // счёт точками выпустил бы сообщение длиннее предела, и отказ пришёл
  // бы уже от Telegram (`telegram-status.md`, «Отправка»).
  const line = "🚀".repeat(10);
  const text = `${line}\n${line}`;
  await t.step("текст длиннее предела в единицах — усекается", () => {
    const cut = cutToLimit(text, 33);
    assertEquals(cut, `${line}\n…(обрезано)`);
    assertEquals(cut.length <= 33, true, `${cut.length} единиц`);
  });
  await t.step("текст короче предела — не трогается", () => {
    assertEquals(cutToLimit(text, text.length), text);
  });
});
