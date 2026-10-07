import { describe, expect, it } from "vitest";
import { rejected, thrown } from "../testing/thrown.ts";
import { z } from "zod";
import {
  defineCommand,
  DomainError,
  formatCommandError,
  UsageError,
} from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";

/** Минимальное корректное объявление; поля подменяются в тестах. */
function declare(
  overrides: { summary?: string; usage?: string; help?: string },
) {
  return defineCommand({
    path: ["proba"],
    summary: "проба пера",
    usage: "mpu proba",
    help: "Подробности пробы.",
    policy: "ro",
    argsSchema: z.object({}),
    resultSchema: z.object({ ok: z.boolean() }),
    run: () => Promise.resolve({ ok: true }),
    render: () => "",
    ...overrides,
  });
}

describe("объявление без справочного текста не собирается", () => {
  const cases: readonly (readonly [string, { [k: string]: string }])[] = [
    ["назначение", { summary: "" }],
    ["строка использования", { usage: "" }],
    ["справка", { help: "" }],
    // Пробелы текстом не считаются: индекс родителя останется пустым.
    ["назначение из пробелов", { summary: "   " }],
  ];
  for (const [title, overrides] of cases) {
    it(title, () => {
      thrown(
        () => declare(overrides),
        TypeError,
        "текст обязателен",
      );
    });
  }
});

it("корректное объявление собирается и несёт свои тексты", () => {
  const command = declare({});
  expect(command.path).toStrictEqual(["proba"]);
  expect(command.summary).toBe("проба пера");
  expect(command.policy).toBe("ro");
});

describe("вход MCP: не объект — ошибка ввода, а не падение", () => {
  const command = declare({});
  const io = makeFakeIo();
  // Схема сама по себе такой вход отвергла бы невнятно: агенту нужно
  // сообщение про форму аргументов, а не про поля объекта.
  for (const input of [42, "строка", ["массив"], null]) {
    it(JSON.stringify(input) ?? "null", async () => {
      await rejected(
        () => command.invokeInput(input, io),
        UsageError,
        "arguments must be an object",
      );
    });
  }
});

it("разбор argv, давший не объект, — дефект объявления", () => {
  // Схема аргументов, корень которой не объект, до реестра не доходит:
  // её отвергает проверка формы схемы. Здесь — вторая сеть, на случай
  // схемы, чей разбор возвращает не то, что обещал корень.
  const command = defineCommand({
    path: ["proba"],
    summary: "проба пера",
    usage: "mpu proba",
    help: "Подробности пробы.",
    policy: "ro",
    argsSchema: z.object({}).transform(() => "не объект"),
    resultSchema: z.object({ ok: z.boolean() }),
    run: () => Promise.resolve({ ok: true }),
    render: () => "",
  });
  thrown(() => command.parseArgs([]), TypeError, "разбор дал не объект");
});

describe("formatCommandError: две формы подсказки", () => {
  it("готовая команда — после «попробуй:»", () => {
    const err = new DomainError("записи 7000001 нет на карточке 10000001", {
      hint: "mpu kiten time ls 10000001",
    });
    expect(formatCommandError("kiten time edit", err)).toStrictEqual(
      "mpu kiten time edit: записи 7000001 нет на карточке 10000001; " +
        "попробуй: mpu kiten time ls 10000001",
    );
  });

  it("выбор из нескольких действий — дословно", () => {
    const err = new DomainError("таймер уже идёт на карточке 10000001", {
      advice: "останови `mpu kiten time stop 10000001` или сбрось " +
        "`mpu kiten time discard 10000001`",
    });
    expect(formatCommandError("kiten time start", err)).toStrictEqual(
      "mpu kiten time start: таймер уже идёт на карточке 10000001; " +
        "останови `mpu kiten time stop 10000001` или сбрось " +
        "`mpu kiten time discard 10000001`",
    );
  });

  it("заданы обе — выбор действия старше", () => {
    const err = new UsageError("причина", {
      hint: "команда",
      advice: "выбери",
    });
    expect(formatCommandError("проба", err)).toBe("mpu проба: причина; выбери");
  });
});

describe("числовой список: элементы приводятся к числу из argv", () => {
  const command = defineCommand({
    path: ["proba"],
    summary: "проба пера",
    usage: "mpu proba",
    help: "Подробности пробы.",
    policy: "ro",
    argsSchema: z.object({
      ids: z.array(z.number().int()).optional(),
      names: z.array(z.string()).optional(),
    }),
    resultSchema: z.object({ ok: z.boolean() }),
    run: () => Promise.resolve({ ok: true }),
    render: () => "",
  });

  it("вид входа выведен из типа элемента", () => {
    expect(command.inputs.map((input) => [input.name, input.kind]))
      .toStrictEqual([["ids", "numbers"], ["names", "strings"]]);
  });

  it("повтор флага накапливает числа, а не строки", () => {
    expect(command.parseArgs(["--ids", "1", "--ids", "20"]).ids).toStrictEqual([
      1,
      20,
    ]);
  });

  it("нецифровое значение отвергается схемой, а не молчит", () => {
    // Приведение оставляет негодный текст текстом, и о типе говорит
    // схема — своего сообщения слой разбора не заводит.
    const err = thrown(
      () => command.parseArgs(["--ids", "abc"]),
      UsageError,
    );
    expect(err.hint).toBe("mpu proba --help");
  });

  it("строковый список числами не становится", () => {
    expect(command.parseArgs(["--names", "1"]).names).toStrictEqual(["1"]);
  });
});

describe("пометка «без записи аргументов» доезжает до разбора argv", () => {
  // Маскировка строки вызова бесполезна, пока сообщения разбора эхо-
  // печатают ввод: секции err записи журнала пишутся и у помеченной
  // команды (`platform/invoke-log.md`, «Инварианты»).
  const declaration = {
    path: ["proba"],
    summary: "проба пера",
    usage: "mpu proba MESSAGE",
    help: "Подробности пробы.",
    policy: "ro" as const,
    argsSchema: z.object({ message: z.string() }),
    forms: { message: { positional: "one" as const } },
    resultSchema: z.object({ ok: z.boolean() }),
    run: () => Promise.resolve({ ok: true }),
    render: () => "",
  };
  // Пометки журнала — пара: скрыв ввод, объявление обязано назвать и
  // судьбу вывода (`JournalMarks`). У пробы вывод пуст, скрывать
  // нечего.
  const marked = defineCommand({
    ...declaration,
    logsArguments: false,
    logsOutput: true,
  });
  const plain = defineCommand(declaration);

  it("помеченная: лишний позиционный — REDACTED", () => {
    const err = thrown(
      () => marked.parseArgs(["деплой", "упал"]),
      UsageError,
      "unexpected argument REDACTED",
    );
    expect(err.message.includes("упал")).toBe(false);
  });

  it("помеченная: имя опции названо, значение — нет", () => {
    // Пометка про журнал, а не про экран: имя опции оператор набрал
    // руками и без него не увидит опечатки. Прячется значение — и
    // прячется оно у всех команд, не только у помеченной.
    thrown(
      () => marked.parseArgs(["--мой-секрет"]),
      UsageError,
      'unknown option "--мой-секрет"',
    );
    const err = thrown(
      () => marked.parseArgs(["--мой-секрет=пароль"]),
      UsageError,
      'unknown option "--мой-секрет=REDACTED"',
    );
    expect(err.message.includes("пароль")).toBe(false);
  });

  it("непомеченная: ввод по-прежнему назван дословно", () => {
    // Иначе маскирование испортило бы диагностику всем остальным
    // командам: там ввод в журнале и так уместен.
    thrown(
      () => plain.parseArgs(["деплой", "упал"]),
      UsageError,
      `unexpected argument "упал"`,
    );
    thrown(
      () => plain.parseArgs(["--мой-секрет"]),
      UsageError,
      `unknown option "--мой-секрет"`,
    );
  });
});

it("fromFile — только у текстового входа: у списка объявление не собирается", () => {
  const declared = (input: z.ZodType) =>
    defineCommand({
      path: ["proba"],
      summary: "проба пера",
      usage: "mpu proba",
      help: "Подробности пробы.",
      policy: "ro",
      argsSchema: z.object({ tags: input }),
      resultSchema: z.object({ ok: z.boolean() }),
      run: () => Promise.resolve({ ok: true }),
      render: () => "",
      fromFile: { tags: "tags-file" },
    });
  thrown(
    () => declared(z.array(z.string()).optional()),
    TypeError,
    "proba: fromFile tags — только у текстового входа, а он strings",
  );
  expect(declared(z.string().optional()).fromFile).toStrictEqual({
    tags: "tags-file",
  });
});

it("texts называет входы команды: опечатка — объявление не собирается", () => {
  const declared = (texts: readonly string[]) =>
    defineCommand({
      path: ["proba"],
      summary: "проба пера",
      usage: "mpu proba",
      help: "Подробности пробы.",
      policy: "ro",
      argsSchema: z.object({ chat: z.string().optional() }),
      resultSchema: z.object({ ok: z.boolean() }),
      run: () => Promise.resolve({ ok: true }),
      render: () => "",
      texts,
    });
  thrown(
    () => declared(["chta"]),
    TypeError,
    "proba: texts chta — такого входа нет",
  );
  expect(declared(["chat"]).texts).toStrictEqual(["chat"]);
});
