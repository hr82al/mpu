/**
 * Механика переноса карточки (`docs/specs/kiten-move.md`): резолв
 * колонки, порядок колонок доски, выбор соседа для релога и строка
 * положения. Всё это — чистые преобразования, поэтому проверяются
 * таблицей случаев, а не стендом; сетевую часть закрывает
 * `cmd_close_test.ts`, где та же механика идёт целиком.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import type { Column, KaitenAccess } from "../kaiten/mod.ts";
import { startFakeKaiten } from "../kaiten/testing.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  appliedOf,
  applyMove,
  type MovePlan,
  movesInWindow,
  orderedColumns,
  positionLabel,
  recordMove,
  relogNeighbour,
  resolveColumn,
} from "./card_move.ts";

const BOARD_ID = 4000001;
const CARD_ID = 68757875;

function column(id: number, title: string, sortOrder: number | null): Column {
  return { id, boardId: BOARD_ID, title, sortOrder };
}

/** Порядок массива не совпадает ни с id, ни с положением слева направо. */
const COLUMNS: readonly Column[] = [
  column(5000001, "Готово", 3),
  column(5000002, "Бэклог", 1),
  column(5000003, "В работе", 2),
];

Deno.test("resolveColumn: id, точное имя, подстрока", async (t) => {
  await t.step("числовая ссылка — колонка с этим id", () => {
    assertEquals(resolveColumn(COLUMNS, "5000003").title, "В работе");
  });

  await t.step("точное имя старше подстроки", () => {
    const columns = [...COLUMNS, column(5000004, "Готово к релизу", 4)];
    assertEquals(resolveColumn(columns, "готово").id, 5000001);
  });

  await t.step("подстрока без учёта регистра", () => {
    assertEquals(resolveColumn(COLUMNS, "РАБОТ").id, 5000003);
  });

  await t.step("ни одного совпадения — ошибка ввода", () => {
    assertThrows(
      () => resolveColumn(COLUMNS, "Архив"),
      UsageError,
      "column 'Архив' не найден — см. `mpu kiten columns`",
    );
  });

  await t.step("числовая ссылка мимо доски — тот же отказ", () => {
    assertThrows(
      () => resolveColumn(COLUMNS, "999"),
      UsageError,
      "column '999' не найден",
    );
  });

  await t.step("несколько совпадений — кандидаты в подробностях", () => {
    const err = assertThrows(
      () => resolveColumn(COLUMNS, "о"),
      UsageError,
    ) as UsageError;
    assertEquals(err.message, "column 'о' неоднозначен (3 совпадений):");
    assertEquals(
      err.details,
      "5000001 (Готово)\n5000002 (Бэклог)\n5000003 (В работе)",
    );
  });
});

Deno.test("orderedColumns: слева направо по весу, без веса — в конец", () => {
  const columns = [...COLUMNS, column(5000004, "Без веса", null)];
  assertEquals(
    orderedColumns(columns).map((item) => item.title),
    ["Бэклог", "В работе", "Готово", "Без веса"],
  );
});

Deno.test("orderedColumns: равные веса — по возрастанию id", () => {
  const columns = [column(20, "Б", 1), column(10, "А", 1)];
  assertEquals(orderedColumns(columns).map((item) => item.id), [10, 20]);
});

Deno.test("relogNeighbour: сосед слева, у крайней левой — справа", async (t) => {
  await t.step("обычная колонка — предыдущая по весу", () => {
    assertEquals(relogNeighbour(COLUMNS, 5000001).title, "В работе");
  });

  await t.step("крайняя левая — следующая справа", () => {
    assertEquals(relogNeighbour(COLUMNS, 5000002).title, "В работе");
  });

  await t.step("одна колонка на доске — релог невозможен", () => {
    assertThrows(
      () => relogNeighbour([COLUMNS[0]], 5000001),
      UsageError,
      "на доске одна колонка — релог невозможен",
    );
  });

  await t.step("цели нет среди колонок доски", () => {
    assertThrows(
      () => relogNeighbour(COLUMNS, 999),
      UsageError,
      "целевая колонка не найдена на доске карточки",
    );
  });
});

Deno.test("positionLabel: непустые части через разделитель", async (t) => {
  await t.step("все три части", () => {
    assertEquals(
      positionLabel({
        boardTitle: "Проекты",
        columnTitle: "Бэклог",
        laneTitle: "Разработка",
      }),
      "Проекты · Бэклог · Разработка",
    );
  });

  await t.step("пустые части выпадают", () => {
    assertEquals(
      positionLabel({
        boardTitle: "Проекты",
        columnTitle: "",
        laneTitle: null,
      }),
      "Проекты",
    );
  });

  await t.step("все пусты — прочерк", () => {
    assertEquals(
      positionLabel({ boardTitle: null, columnTitle: null, laneTitle: null }),
      "—",
    );
  });
});

/**
 * Ответ PATCH беднее ответа GET: перемещённую карточку Kaiten отдаёт без
 * названий доски, колонки и дорожки — только оси id (`kiten-move.md`,
 * «Ввод/вывод»). Фикстура повторяет эту бедность: фейк богаче сервера
 * проверял бы сам себя и пропустил бы положение «после», взятое из
 * ответа мутации.
 */
function rawPatched(): Record<string, unknown> {
  return {
    id: CARD_ID,
    title: "Карточка стенда",
    board_id: BOARD_ID,
    column_id: 5000001,
    lane_id: 6000001,
  };
}

/** Та же карточка свежим чтением: у GET названия есть. */
function rawCardAfter(): Record<string, unknown> {
  return {
    id: CARD_ID,
    title: "Карточка стенда",
    board: { id: BOARD_ID, title: "Проекты" },
    column: { id: 5000001, title: "Готово" },
    lane: { title: "Разработка" },
  };
}

function access(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: "test-token" };
}

/** План переноса в «Готово» с уже снятым положением «до». */
function planTo(relog: boolean): MovePlan {
  return {
    columnId: 5000001,
    columnTitle: "Готово",
    relog,
    from: "Проекты · Бэклог · Разработка",
  };
}

Deno.test("applyMove: положение «после» — по свежему GET", async (t) => {
  await t.step("перемещение: PATCH, затем чтение карточки", async () => {
    const fake = startFakeKaiten((seen) =>
      Response.json(
        seen[seen.length - 1].method === "PATCH"
          ? rawPatched()
          : rawCardAfter(),
      )
    );
    try {
      const outcome = await applyMove(
        access(fake.baseUrl),
        CARD_ID,
        appliedOf(planTo(false)),
        COLUMNS,
      );
      assertEquals(outcome.to, "Проекты · Готово · Разработка");
      // Поля строки журнала берутся отсюда же — прочерк в `to_column`
      // и пустые доска с дорожкой ловятся этой же проверкой.
      assertEquals(outcome.card.columnTitle, "Готово");
      assertEquals(outcome.card.boardTitle, "Проекты");
      assertEquals(outcome.card.laneTitle, "Разработка");
      assertEquals(
        fake.seen.map((req) => `${req.method} ${req.pathname}`),
        [
          `PATCH /api/latest/cards/${CARD_ID}`,
          `GET /api/latest/cards/${CARD_ID}`,
        ],
      );
    } finally {
      await fake.stop();
    }
  });

  await t.step("релог: два PATCH и одно чтение — в конце", async () => {
    const fake = startFakeKaiten((seen) =>
      Response.json(
        seen[seen.length - 1].method === "PATCH"
          ? rawPatched()
          : rawCardAfter(),
      )
    );
    try {
      const outcome = await applyMove(
        access(fake.baseUrl),
        CARD_ID,
        appliedOf(planTo(true)),
        COLUMNS,
      );
      assertEquals(outcome.to, "Проекты · Готово · Разработка");
      assertEquals(
        fake.seen.map((req) => req.method),
        ["PATCH", "PATCH", "GET"],
      );
    } finally {
      await fake.stop();
    }
  });
});

Deno.test("журнал за окно: включительно по обеим границам", async (t) => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/cache.db`);
    for (
      const [cardId, movedAt] of [[1, 99], [2, 100], [3, 150], [4, 200], [
        5,
        201,
      ]] as const
    ) {
      recordMove(db, {
        cardId,
        title: `карточка ${cardId}`,
        url: `https://kaiten.example/${cardId}`,
        toColumn: "Готово",
        fromColumn: "В работе",
        lane: null,
        board: null,
        note: "",
        movedAt,
      });
    }
    await t.step("границы окна попадают в выдачу", () => {
      assertEquals(
        movesInWindow(db, 100, 200).map((move) => move.cardId),
        [2, 3, 4],
      );
    });
    await t.step("нужные поля строки и ничего сверх", () => {
      assertEquals(movesInWindow(db, 150, 150), [
        {
          cardId: 3,
          title: "карточка 3",
          url: "https://kaiten.example/3",
          toColumn: "Готово",
          movedAt: 150,
        },
      ]);
    });
    await t.step("пустое окно — пустой список, не ошибка", () => {
      assertEquals(movesInWindow(db, 1000, 2000), []);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("журнал читается и на несозданной схеме", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/cache.db`);
    assertEquals(movesInWindow(db, 0, 10), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
