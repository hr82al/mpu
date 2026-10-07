/**
 * Конвейер этапов `mpu kiten status` (`docs/specs/kiten-status.md`).
 * Проверяется правило, а не данные: подстроки колонок заданы спекой,
 * и порядок их проверки — единственное, что различает «Готово к
 * тестированию» и «Готово».
 */

import { describe, expect, it } from "vitest";
import { isEscalated, stageFromInput, stageMapOf, stageOf } from "./stage.ts";

describe("этап колонки: сопоставление от конца конвейера", () => {
  it("«Готово к тестированию» — это Тест, а не Готово", () => {
    expect(stageOf("Готово к тестированию")).toBe("Тест");
    expect(stageOf("готово")).toBe("Готово");
    expect(stageOf("Выполненные задачи")).toBe("Готово");
  });

  it("подстроки каждого этапа", () => {
    expect(stageOf("Очередь задач")).toBe("Очередь");
    expect(stageOf("Backlog")).toBe("Очередь");
    expect(stageOf("Оценка трудозатрат")).toBe("Оценка");
    expect(stageOf("В работе")).toBe("В работе");
    expect(stageOf("Разработка")).toBe("В работе");
    expect(stageOf("Ревью кода")).toBe("Ревью");
    expect(stageOf("Согласование")).toBe("Ревью");
    expect(stageOf("Тестирование")).toBe("Тест");
    expect(stageOf("DEV")).toBe("DEV");
    expect(stageOf("Выгружено")).toBe("DEV");
    expect(stageOf("Предпрод")).toBe("Пред-прод");
    expect(stageOf("ФГ")).toBe("Пред-прод");
  });

  it("регистр не важен, ничего не совпало — прочерк", () => {
    expect(stageOf("РЕВЬЮ")).toBe("Ревью");
    // Подстрока спеки — «согласовани»: «Согласовано» под неё не
    // подходит, и придумывать сверх списка нельзя.
    expect(stageOf("Согласовано с клиентом")).toBe("—");
    expect(stageOf("Придумать название")).toBe("—");
    expect(stageOf(null)).toBe("—");
    expect(stageOf("   ")).toBe("—");
  });

  it("карта env перекрывает правила своих колонок", () => {
    const map = stageMapOf({ "Придумать название": "work" });
    expect(stageOf("Придумать название", map)).toBe("В работе");
    // Ключ сравнивается без учёта регистра, чужие колонки не тронуты.
    expect(stageOf("придумать НАЗВАНИЕ", map)).toBe("В работе");
    expect(stageOf("Тестирование", map)).toBe("Тест");
  });

  it("карта с мусором не роняет разбор", () => {
    const map = stageMapOf({ Колонка: 42, Другая: "нет такого этапа" });
    expect(map).toStrictEqual({});
  });
});

it("эскалация — признак строки, а не отдельный этап", () => {
  expect(isEscalated("Эскалация")).toBe(true);
  expect(stageOf("Эскалация")).toBe("В работе");
  expect(isEscalated("В работе")).toBe(false);
  expect(isEscalated(null)).toBe(false);
});

describe("значение --stage: алиас, точное имя, подстрока", () => {
  it("латинские алиасы", () => {
    expect(stageFromInput("queue")).toBe("Очередь");
    expect(stageFromInput("preprod")).toBe("Пред-прод");
    expect(stageFromInput("DONE")).toBe("Готово");
  });

  it("точное имя и подстрока канонического", () => {
    expect(stageFromInput("В работе")).toBe("В работе");
    expect(stageFromInput("ревь")).toBe("Ревью");
  });

  it("неоднозначная подстрока и мусор — null", () => {
    // «о» встречается в нескольких этапах: выбирать за пользователя
    // нельзя, отказ даст вызывающий со списком алиасов.
    expect(stageFromInput("о")).toStrictEqual(null);
    expect(stageFromInput("нет такого")).toStrictEqual(null);
    expect(stageFromInput("  ")).toStrictEqual(null);
  });
});
