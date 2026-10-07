/**
 * Механика переноса карточки (`docs/specs/kiten-move.md`): резолв
 * колонки, порядок колонок доски, выбор соседа для релога и строка
 * положения. Всё это — чистые преобразования, поэтому проверяются
 * таблицей случаев, а не стендом; сетевую часть закрывает
 * `cmd_close_test.ts`, где та же механика идёт целиком.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { type CacheDb, UsageError } from "../command/mod.ts";
import type { Column, KaitenAccess } from "../kaiten/mod.ts";
import { startFakeKaiten } from "../kaiten/testing.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  appliedOf,
  applyMove,
  moveOkLine,
  type MovePlan,
  movesInWindow,
  orderedColumns,
  planAxisMove,
  positionLabel,
  recordMove,
  relogNeighbour,
} from "./card_move.ts";
import { resolveRef } from "./ref.ts";

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

describe("resolveColumn: id, точное имя, подстрока", () => {
  it("числовая ссылка — колонка с этим id", () => {
    expect(resolveRef("column", COLUMNS, "5000003").title).toBe("В работе");
  });

  it("точное имя старше подстроки", () => {
    const columns = [...COLUMNS, column(5000004, "Готово к релизу", 4)];
    expect(resolveRef("column", columns, "готово").id).toBe(5000001);
  });

  it("подстрока без учёта регистра", () => {
    expect(resolveRef("column", COLUMNS, "РАБОТ").id).toBe(5000003);
  });

  it("ни одного совпадения — ошибка ввода", () => {
    expect(() => resolveRef("column", COLUMNS, "Архив")).toThrow(UsageError);
    expect(() => resolveRef("column", COLUMNS, "Архив")).toThrow(
      "column 'Архив' не найден — см. `mpu kiten columns`",
    );
  });

  it("числовая ссылка мимо доски — тот же отказ", () => {
    expect(() => resolveRef("column", COLUMNS, "999")).toThrow(UsageError);
    expect(() => resolveRef("column", COLUMNS, "999")).toThrow(
      "column '999' не найден",
    );
  });

  it("несколько совпадений — кандидаты в подробностях", () => {
    const err = thrown(() => {
      resolveRef("column", COLUMNS, "о");
    }, UsageError);
    expect(err.message).toBe("column 'о' неоднозначен (3 совпадений):");
    expect(err.details).toBe(
      "5000001 (Готово)\n5000002 (Бэклог)\n5000003 (В работе)",
    );
  });
});

it("orderedColumns: слева направо по весу, без веса — в конец", () => {
  const columns = [...COLUMNS, column(5000004, "Без веса", null)];
  expect(orderedColumns(columns).map((item) => item.title)).toStrictEqual([
    "Бэклог",
    "В работе",
    "Готово",
    "Без веса",
  ]);
});

it("orderedColumns: равные веса — по возрастанию id", () => {
  const columns = [column(20, "Б", 1), column(10, "А", 1)];
  expect(orderedColumns(columns).map((item) => item.id)).toStrictEqual([
    10,
    20,
  ]);
});

describe("relogNeighbour: сосед слева, у крайней левой — справа", () => {
  it("обычная колонка — предыдущая по весу", () => {
    expect(relogNeighbour(COLUMNS, 5000001).title).toBe("В работе");
  });

  it("крайняя левая — следующая справа", () => {
    expect(relogNeighbour(COLUMNS, 5000002).title).toBe("В работе");
  });

  it("одна колонка на доске — релог невозможен", () => {
    expect(() => relogNeighbour([COLUMNS[0]], 5000001)).toThrow(UsageError);
    expect(() => relogNeighbour([COLUMNS[0]], 5000001)).toThrow(
      "на доске одна колонка — релог невозможен",
    );
  });

  it("цели нет среди колонок доски", () => {
    expect(() => relogNeighbour(COLUMNS, 999)).toThrow(UsageError);
    expect(() => relogNeighbour(COLUMNS, 999)).toThrow(
      "целевая колонка не найдена на доске карточки",
    );
  });
});

describe("positionLabel: непустые части через разделитель", () => {
  it("все три части", () => {
    expect(positionLabel({
      boardTitle: "Проекты",
      columnTitle: "Бэклог",
      laneTitle: "Разработка",
    })).toBe("Проекты · Бэклог · Разработка");
  });

  it("пустые части выпадают", () => {
    expect(positionLabel({
      boardTitle: "Проекты",
      columnTitle: "",
      laneTitle: null,
    })).toBe("Проекты");
  });

  it("все пусты — прочерк", () => {
    expect(
      positionLabel({ boardTitle: null, columnTitle: null, laneTitle: null }),
    ).toBe("—");
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

describe("applyMove: положение «после» — по свежему GET", () => {
  it("перемещение: PATCH, затем чтение карточки", async () => {
    const fake = await startFakeKaiten((seen) =>
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
      expect(outcome.to).toBe("Проекты · Готово · Разработка");
      // Поля строки журнала берутся отсюда же — прочерк в `to_column`
      // и пустые доска с дорожкой ловятся этой же проверкой.
      expect(outcome.card.columnTitle).toBe("Готово");
      expect(outcome.card.boardTitle).toBe("Проекты");
      expect(outcome.card.laneTitle).toBe("Разработка");
      expect(fake.seen.map((req) => `${req.method} ${req.pathname}`))
        .toStrictEqual([
          `PATCH /api/latest/cards/${CARD_ID}`,
          `GET /api/latest/cards/${CARD_ID}`,
        ]);
    } finally {
      await fake.stop();
    }
  });

  it("релог: два PATCH и одно чтение — в конце", async () => {
    const fake = await startFakeKaiten((seen) =>
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
      expect(outcome.to).toBe("Проекты · Готово · Разработка");
      expect(fake.seen.map((req) => req.method)).toStrictEqual([
        "PATCH",
        "PATCH",
        "GET",
      ]);
    } finally {
      await fake.stop();
    }
  });
});

describe("журнал за окно: включительно по обеим границам", () => {
  // Шаги только читают один журнал — он открыт на весь describe.
  let dir = "";
  let db: CacheDb;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpu-"));
    db = openCacheDb(`${dir}/cache.db`);
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
  });
  afterAll(async () => {
    try {
      db[Symbol.dispose]();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("границы окна попадают в выдачу", () => {
    expect(movesInWindow(db, 100, 200).map((move) => move.cardId))
      .toStrictEqual([2, 3, 4]);
  });
  it("нужные поля строки и ничего сверх", () => {
    expect(movesInWindow(db, 150, 150)).toStrictEqual([
      {
        cardId: 3,
        title: "карточка 3",
        url: "https://kaiten.example/3",
        toColumn: "Готово",
        movedAt: 150,
      },
    ]);
  });
  it("пустое окно — пустой список, не ошибка", () => {
    expect(movesInWindow(db, 1000, 2000)).toStrictEqual([]);
  });
});

it("журнал читается и на несозданной схеме", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/cache.db`);
    expect(movesInWindow(db, 0, 10)).toStrictEqual([]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

describe("planAxisMove: в PATCH идут только заданные оси", () => {
  const card = {
    boardId: BOARD_ID,
    columnId: 5000002,
    boardTitle: "Разработка",
    columnTitle: "Бэклог",
    laneTitle: "Веб",
  };
  const target = column(5000001, "Готово", 3);
  const lane = { id: 6000001, title: "Веб" };
  it("одна колонка", () => {
    const made = planAxisMove(card, {
      board: null,
      lane: null,
      column: target,
    });
    expect(made.patch).toStrictEqual({ columnId: 5000001 });
    expect(made.relogTarget).toStrictEqual(null);
    expect(made.from).toBe("Разработка · Бэклог · Веб");
  });
  it("три оси разом", () => {
    const made = planAxisMove(card, {
      board: { id: 4000002, title: "Поддержка" },
      lane: { id: 6000009, title: "Мобилки" },
      column: target,
    });
    expect(made.patch).toStrictEqual({
      boardId: 4000002,
      laneId: 6000009,
      columnId: 5000001,
    });
  });
  it("колонка не задана — релога нет", () => {
    const made = planAxisMove(card, { board: null, lane, column: null });
    expect(made.patch).toStrictEqual({ laneId: 6000001 });
    expect(made.relogTarget).toStrictEqual(null);
  });
});

describe("planAxisMove: релог решается сравнением значений", () => {
  const card = {
    boardId: BOARD_ID,
    columnId: 5000001,
    boardTitle: "Разработка",
    columnTitle: "Готово",
    laneTitle: "Веб",
  };
  const current = column(5000001, "Готово", 3);
  const board = { id: BOARD_ID, title: "Разработка" };
  const lane = { id: 6000001, title: "Веб" };
  it("текущая колонка — релог", () => {
    expect(
      planAxisMove(card, { board: null, lane: null, column: current })
        .relogTarget,
    ).toBe(5000001);
  });
  it("текущая колонка и те же доска с дорожкой — тоже релог", () => {
    expect(planAxisMove(card, { board, lane, column: current }).relogTarget)
      .toBe(5000001);
  });
  it("другая доска при той же колонке — обычный PATCH", () => {
    expect(
      planAxisMove(card, {
        board: { id: 4000002, title: "Поддержка" },
        lane: null,
        column: current,
      }).relogTarget,
    ).toStrictEqual(null);
  });
  it("другая дорожка при той же колонке — обычный PATCH", () => {
    expect(
      planAxisMove(card, {
        board: null,
        lane: { id: 6000009, title: "Мобилки" },
        column: current,
      }).relogTarget,
    ).toStrictEqual(null);
  });
  it("другая колонка — обычный PATCH", () => {
    expect(
      planAxisMove(card, {
        board: null,
        lane: null,
        column: column(5000002, "Бэклог", 1),
      }).relogTarget,
    ).toStrictEqual(null);
  });
});

describe("строки успеха совпадают с голденами канала", () => {
  const url = "https://kaiten.example/70000001";
  it("перемещение", async () => {
    expect(moveOkLine({
      from: "Разработка · Бэклог · Веб",
      to: "Разработка · Готово · Веб",
      relog: false,
    }, url)).toStrictEqual(
      await readFile(
        new URL("./testdata/kiten-move/ok-move-stdout.txt", import.meta.url),
        "utf8",
      ),
    );
  });
  it("релог", async () => {
    expect(moveOkLine({
      from: "Разработка · Готово · Веб",
      to: "Разработка · Готово · Веб",
      relog: true,
    }, url)).toStrictEqual(
      await readFile(
        new URL("./testdata/kiten-move/ok-relog-stdout.txt", import.meta.url),
        "utf8",
      ),
    );
  });
});

describe("релог невозможен: два отказа с разными текстами", () => {
  it("список колонок пуст", () => {
    expect(() => relogNeighbour([], 5000001)).toThrow(UsageError);
    expect(() => relogNeighbour([], 5000001)).toThrow(
      "не удалось получить колонки доски для релога",
    );
  });
  it("на доске одна колонка", () => {
    expect(() => relogNeighbour([column(5000001, "Готово", 1)], 5000001))
      .toThrow(UsageError);
    expect(() => relogNeighbour([column(5000001, "Готово", 1)], 5000001))
      .toThrow("на доске одна колонка — релог невозможен");
  });
  it("целевой колонки нет в списке", () => {
    expect(() => relogNeighbour(COLUMNS, 999)).toThrow(UsageError);
    expect(() => relogNeighbour(COLUMNS, 999)).toThrow(
      "целевая колонка не найдена на доске карточки",
    );
  });
});
