/**
 * Конвейер этапов `mpu kiten status` (`docs/specs/kiten-status.md`).
 * Проверяется правило, а не данные: подстроки колонок заданы спекой,
 * и порядок их проверки — единственное, что различает «Готово к
 * тестированию» и «Готово».
 */

import { assertEquals } from "@std/assert";
import { isEscalated, stageFromInput, stageMapOf, stageOf } from "./stage.ts";

Deno.test("этап колонки: сопоставление от конца конвейера", async (t) => {
  await t.step("«Готово к тестированию» — это Тест, а не Готово", () => {
    assertEquals(stageOf("Готово к тестированию"), "Тест");
    assertEquals(stageOf("готово"), "Готово");
    assertEquals(stageOf("Выполненные задачи"), "Готово");
  });

  await t.step("подстроки каждого этапа", () => {
    assertEquals(stageOf("Очередь задач"), "Очередь");
    assertEquals(stageOf("Backlog"), "Очередь");
    assertEquals(stageOf("Оценка трудозатрат"), "Оценка");
    assertEquals(stageOf("В работе"), "В работе");
    assertEquals(stageOf("Разработка"), "В работе");
    assertEquals(stageOf("Ревью кода"), "Ревью");
    assertEquals(stageOf("Согласование"), "Ревью");
    assertEquals(stageOf("Тестирование"), "Тест");
    assertEquals(stageOf("DEV"), "DEV");
    assertEquals(stageOf("Выгружено"), "DEV");
    assertEquals(stageOf("Предпрод"), "Пред-прод");
    assertEquals(stageOf("ФГ"), "Пред-прод");
  });

  await t.step("регистр не важен, ничего не совпало — прочерк", () => {
    assertEquals(stageOf("РЕВЬЮ"), "Ревью");
    // Подстрока спеки — «согласовани»: «Согласовано» под неё не
    // подходит, и придумывать сверх списка нельзя.
    assertEquals(stageOf("Согласовано с клиентом"), "—");
    assertEquals(stageOf("Придумать название"), "—");
    assertEquals(stageOf(null), "—");
    assertEquals(stageOf("   "), "—");
  });

  await t.step("карта env перекрывает правила своих колонок", () => {
    const map = stageMapOf({ "Придумать название": "work" });
    assertEquals(stageOf("Придумать название", map), "В работе");
    // Ключ сравнивается без учёта регистра, чужие колонки не тронуты.
    assertEquals(stageOf("придумать НАЗВАНИЕ", map), "В работе");
    assertEquals(stageOf("Тестирование", map), "Тест");
  });

  await t.step("карта с мусором не роняет разбор", () => {
    const map = stageMapOf({ "Колонка": 42, "Другая": "нет такого этапа" });
    assertEquals(map, {});
  });
});

Deno.test("эскалация — признак строки, а не отдельный этап", () => {
  assertEquals(isEscalated("Эскалация"), true);
  assertEquals(stageOf("Эскалация"), "В работе");
  assertEquals(isEscalated("В работе"), false);
  assertEquals(isEscalated(null), false);
});

Deno.test("значение --stage: алиас, точное имя, подстрока", async (t) => {
  await t.step("латинские алиасы", () => {
    assertEquals(stageFromInput("queue"), "Очередь");
    assertEquals(stageFromInput("preprod"), "Пред-прод");
    assertEquals(stageFromInput("DONE"), "Готово");
  });

  await t.step("точное имя и подстрока канонического", () => {
    assertEquals(stageFromInput("В работе"), "В работе");
    assertEquals(stageFromInput("ревь"), "Ревью");
  });

  await t.step("неоднозначная подстрока и мусор — null", () => {
    // «о» встречается в нескольких этапах: выбирать за пользователя
    // нельзя, отказ даст вызывающий со списком алиасов.
    assertEquals(stageFromInput("о"), null);
    assertEquals(stageFromInput("нет такого"), null);
    assertEquals(stageFromInput("  "), null);
  });
});
