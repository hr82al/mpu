import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import { UsageError } from "../command/mod.ts";
import type { Column, Lane } from "@mpu/kaiten";
import { resolveRef } from "./ref.ts";

const BOARD_ID = 4000001;

function column(id: number, title: string, sortOrder: number | null): Column {
  return { id, boardId: BOARD_ID, title, sortOrder };
}

/** Порядок массива не совпадает ни с id, ни с положением слева направо. */
const COLUMNS: readonly Column[] = [
  column(5000001, "Готово", 3),
  column(5000002, "Бэклог", 1),
  column(5000003, "В работе", 2),
];

const LANES: readonly Lane[] = [
  { id: 6000001, boardId: BOARD_ID, title: "Веб" },
  { id: 6000002, boardId: BOARD_ID, title: "Мобилки" },
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

describe("вид справочника стоит в отказе", () => {
  it("дорожка не найдена", () => {
    expect(() => resolveRef("lane", LANES, "Десктоп")).toThrow(UsageError);
    expect(() => resolveRef("lane", LANES, "Десктоп")).toThrow(
      "lane 'Десктоп' не найден — см. `mpu kiten lanes`",
    );
  });
  it("доска неоднозначна", () => {
    const err = thrown(() => {
      resolveRef(
        "board",
        [
          { id: 1, title: "Поддержка" },
          { id: 2, title: "Поддержка клиентов" },
        ],
        "поддержк",
      );
    }, UsageError);
    expect(err.message).toBe("board 'поддержк' неоднозначен (2 совпадений):");
    expect(err.details).toBe("1 (Поддержка)\n2 (Поддержка клиентов)");
  });
  it("резолв возвращает саму запись, не только id", () => {
    expect(resolveRef("lane", LANES, "6000002").title).toBe("Мобилки");
  });
});
