import { assertEquals } from "@std/assert";
import { mskDayWindow } from "./status_day.ts";
import {
  liveMoves,
  liveSkippedWarning,
  type LiveSource,
} from "./status_live.ts";

const NOW_MS = Date.parse("2026-08-17T07:00:00.000Z");
const WINDOW = mskDayWindow(NOW_MS);
const ME = 900001;

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-status/${name}`, import.meta.url),
  );
}

function source(over: Partial<LiveSource> = {}): LiveSource {
  return {
    currentUserId: () => Promise.resolve(ME),
    cardsUpdated: () => Promise.resolve([]),
    cardHistory: () => Promise.reject(new Error("история не ожидалась")),
    boardColumns: () => Promise.reject(new Error("колонки не ожидались")),
    ...over,
  };
}

function options(warn: (line: string) => void = () => {}) {
  return {
    window: WINDOW,
    cardUrl: (cardId: number) => `https://kaiten.example/${cardId}`,
    warn,
  };
}

/** Момент внутри сегодняшнего окна, ISO UTC. */
const AT_10 = "2026-08-17T07:00:00Z";
const AT_09 = "2026-08-17T06:00:00Z";

Deno.test("в отчёт идут только мои смены колонки за сегодня", async () => {
  const moves = await liveMoves(
    source({
      cardsUpdated: () =>
        Promise.resolve([
          { id: 1, title: "моя", boardId: 10 },
          { id: 2, title: "чужая", boardId: 10 },
          { id: 3, title: "вчерашняя", boardId: 10 },
        ]),
      cardHistory: (cardId) =>
        Promise.resolve(
          cardId === 1
            ? [
              { columnId: 501, authorId: ME, changed: AT_09 },
              { columnId: 502, authorId: ME, changed: AT_10 },
            ]
            : cardId === 2
            ? [{ columnId: 501, authorId: 900002, changed: AT_10 }]
            : [{
              columnId: 501,
              authorId: ME,
              changed: "2026-08-16T07:00:00Z",
            }],
        ),
      boardColumns: () =>
        Promise.resolve([
          { id: 501, title: "В работе" },
          { id: 502, title: "Готово" },
        ]),
    }),
    options(),
  );
  // Из двух моих смен берётся последняя.
  assertEquals(moves, [
    {
      cardId: 1,
      title: "моя",
      url: "https://kaiten.example/1",
      column: "Готово",
      movedAt: Date.parse(AT_10) / 1000,
    },
  ]);
});

Deno.test("название колонки: доска, id числом, прочерк", async (t) => {
  const card = (columnId: number | null) =>
    liveMoves(
      source({
        cardsUpdated: () =>
          Promise.resolve([{ id: 1, title: "к", boardId: 10 }]),
        cardHistory: () =>
          Promise.resolve([{ columnId, authorId: ME, changed: AT_10 }]),
        boardColumns: () => Promise.resolve([{ id: 501, title: "Готово" }]),
      }),
      options(),
    );
  await t.step("колонка есть в ответе доски — её название", async () => {
    assertEquals((await card(501))[0].column, "Готово");
  });
  await t.step("названия нет — id колонки числом", async () => {
    assertEquals((await card(777))[0].column, "777");
  });
  await t.step("название пустое — тоже id колонки числом", async () => {
    const moves = await liveMoves(
      source({
        cardsUpdated: () =>
          Promise.resolve([{ id: 1, title: "к", boardId: 10 }]),
        cardHistory: () =>
          Promise.resolve([{ columnId: 501, authorId: ME, changed: AT_10 }]),
        boardColumns: () => Promise.resolve([{ id: 501, title: "" }]),
      }),
      options(),
    );
    assertEquals(moves[0].column, "501");
  });
  await t.step("id колонки нет — прочерк", async () => {
    assertEquals((await card(null))[0].column, "—");
  });
});

Deno.test("колонки доски недоступны — id числом, без предупреждения", async () => {
  const warnings: string[] = [];
  const moves = await liveMoves(
    source({
      cardsUpdated: () => Promise.resolve([{ id: 1, title: "к", boardId: 10 }]),
      cardHistory: () =>
        Promise.resolve([{ columnId: 501, authorId: ME, changed: AT_10 }]),
      boardColumns: () => Promise.reject(new Error("403 Forbidden")),
    }),
    options((line) => void warnings.push(line)),
  );
  assertEquals(moves[0].column, "501");
  assertEquals(warnings, []);
});

Deno.test("доска карточки неизвестна — колонка id числом", async () => {
  const moves = await liveMoves(
    source({
      cardsUpdated: () =>
        Promise.resolve([{ id: 1, title: "к", boardId: null }]),
      cardHistory: () =>
        Promise.resolve([{ columnId: 501, authorId: ME, changed: AT_10 }]),
    }),
    options(),
  );
  assertEquals(moves[0].column, "501");
});

Deno.test("колонки доски запрашиваются по одному разу на доску", async () => {
  const boards: number[] = [];
  await liveMoves(
    source({
      cardsUpdated: () =>
        Promise.resolve([
          { id: 1, title: "а", boardId: 10 },
          { id: 2, title: "б", boardId: 10 },
          { id: 3, title: "в", boardId: 11 },
        ]),
      cardHistory: () =>
        Promise.resolve([{ columnId: 501, authorId: ME, changed: AT_10 }]),
      boardColumns: (boardId) => {
        boards.push(boardId);
        return Promise.resolve([{ id: 501, title: "Готово" }]);
      },
    }),
    options(),
  );
  assertEquals(boards, [10, 11]);
});

Deno.test("история карточки недоступна: предупреждение и пропуск", async () => {
  const warnings: string[] = [];
  const moves = await liveMoves(
    source({
      cardsUpdated: () =>
        Promise.resolve([
          { id: 70000003, title: "к", boardId: 10 },
          { id: 2, title: "живая", boardId: 10 },
        ]),
      cardHistory: (cardId) =>
        cardId === 70000003
          ? Promise.reject(new Error("403 Forbidden"))
          : Promise.resolve([{ columnId: 501, authorId: ME, changed: AT_10 }]),
      boardColumns: () => Promise.resolve([{ id: 501, title: "Готово" }]),
    }),
    options((line) => void warnings.push(line)),
  );
  assertEquals(moves.map((move) => move.cardId), [2]);
  assertEquals(
    `${warnings.join("\n")}\n`,
    await golden(
      "warn-card-history-stderr.txt",
    ),
  );
});

Deno.test("строки предупреждений совпадают с голденами", async (t) => {
  await t.step("живой опрос пропущен", async () => {
    assertEquals(
      `${liveSkippedWarning(new Error("401 Unauthorized"))}\n`,
      await golden("warn-live-skipped-stderr.txt"),
    );
  });
  await t.step("отказ без Error — тем же текстом", () => {
    assertEquals(
      liveSkippedWarning("нет ключа"),
      "mpu telegram status: live-обогащение пропущено (Kaiten: нет ключа)",
    );
  });
});

Deno.test("мой id запрашивается раньше выборки карточек", async () => {
  const calls: string[] = [];
  await liveMoves(
    source({
      currentUserId: () => {
        calls.push("me");
        return Promise.resolve(ME);
      },
      cardsUpdated: (memberId, window) => {
        calls.push(`cards ${memberId} ${window.fromIso}`);
        return Promise.resolve([]);
      },
    }),
    options(),
  );
  assertEquals(calls, ["me", `cards ${ME} ${WINDOW.fromIso}`]);
});
