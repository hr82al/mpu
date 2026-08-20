import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "@zod/zod";
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

Deno.test("объявление без справочного текста не собирается", async (t) => {
  const cases: readonly (readonly [string, { [k: string]: string }])[] = [
    ["назначение", { summary: "" }],
    ["строка использования", { usage: "" }],
    ["справка", { help: "" }],
    // Пробелы текстом не считаются: индекс родителя останется пустым.
    ["назначение из пробелов", { summary: "   " }],
  ];
  for (const [title, overrides] of cases) {
    await t.step(title, () => {
      assertThrows(
        () => declare(overrides),
        TypeError,
        "текст обязателен",
      );
    });
  }
});

Deno.test("корректное объявление собирается и несёт свои тексты", () => {
  const command = declare({});
  assertEquals(command.path, ["proba"]);
  assertEquals(command.summary, "проба пера");
  assertEquals(command.policy, "ro");
});

Deno.test("вход MCP: не объект — ошибка ввода, а не падение", async (t) => {
  const command = declare({});
  const io = makeFakeIo();
  // Схема сама по себе такой вход отвергла бы невнятно: агенту нужно
  // сообщение про форму аргументов, а не про поля объекта.
  for (const input of [42, "строка", ["массив"], null]) {
    await t.step(JSON.stringify(input) ?? "null", async () => {
      await assertRejects(
        () => command.invokeInput(input, io),
        UsageError,
        "arguments must be an object",
      );
    });
  }
});

Deno.test("разбор argv, давший не объект, — дефект объявления", () => {
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
  assertThrows(() => command.parseArgs([]), TypeError, "разбор дал не объект");
});

Deno.test("formatCommandError: две формы подсказки", async (t) => {
  await t.step("готовая команда — после «попробуй:»", () => {
    const err = new DomainError("записи 7000001 нет на карточке 10000001", {
      hint: "mpu kiten time ls 10000001",
    });
    assertEquals(
      formatCommandError("kiten time edit", err),
      "mpu kiten time edit: записи 7000001 нет на карточке 10000001; " +
        "попробуй: mpu kiten time ls 10000001",
    );
  });

  await t.step("выбор из нескольких действий — дословно", () => {
    const err = new DomainError("таймер уже идёт на карточке 10000001", {
      advice: "останови `mpu kiten time stop 10000001` или сбрось " +
        "`mpu kiten time discard 10000001`",
    });
    assertEquals(
      formatCommandError("kiten time start", err),
      "mpu kiten time start: таймер уже идёт на карточке 10000001; " +
        "останови `mpu kiten time stop 10000001` или сбрось " +
        "`mpu kiten time discard 10000001`",
    );
  });

  await t.step("заданы обе — выбор действия старше", () => {
    const err = new UsageError("причина", {
      hint: "команда",
      advice: "выбери",
    });
    assertEquals(
      formatCommandError("проба", err),
      "mpu проба: причина; выбери",
    );
  });
});

Deno.test("числовой список: элементы приводятся к числу из argv", async (t) => {
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

  await t.step("вид входа выведен из типа элемента", () => {
    assertEquals(
      command.inputs.map((input) => [input.name, input.kind]),
      [["ids", "numbers"], ["names", "strings"]],
    );
  });

  await t.step("повтор флага накапливает числа, а не строки", () => {
    assertEquals(
      command.parseArgs(["--ids", "1", "--ids", "20"]).ids,
      [1, 20],
    );
  });

  await t.step("нецифровое значение отвергается схемой, а не молчит", () => {
    // Приведение оставляет негодный текст текстом, и о типе говорит
    // схема — своего сообщения слой разбора не заводит.
    const err = assertThrows(
      () => command.parseArgs(["--ids", "abc"]),
      UsageError,
    );
    assertEquals(err.hint, "mpu proba --help");
  });

  await t.step("строковый список числами не становится", () => {
    assertEquals(command.parseArgs(["--names", "1"]).names, ["1"]);
  });
});

Deno.test("пометка «без записи аргументов» доезжает до разбора argv", async (t) => {
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
  const marked = defineCommand({ ...declaration, logsArguments: false });
  const plain = defineCommand(declaration);

  await t.step("помеченная: лишний позиционный — REDACTED", () => {
    const err = assertThrows(
      () => marked.parseArgs(["деплой", "упал"]),
      UsageError,
      "unexpected argument REDACTED",
    );
    assertEquals(err.message.includes("упал"), false);
  });

  await t.step("помеченная: неизвестная опция — REDACTED", () => {
    const err = assertThrows(
      () => marked.parseArgs(["--мой-секрет"]),
      UsageError,
      "unknown option REDACTED",
    );
    assertEquals(err.message.includes("мой-секрет"), false);
  });

  await t.step("непомеченная: ввод по-прежнему назван дословно", () => {
    // Иначе маскирование испортило бы диагностику всем остальным
    // командам: там ввод в журнале и так уместен.
    assertThrows(
      () => plain.parseArgs(["деплой", "упал"]),
      UsageError,
      `unexpected argument "упал"`,
    );
    assertThrows(
      () => plain.parseArgs(["--мой-секрет"]),
      UsageError,
      `unknown option "--мой-секрет"`,
    );
  });
});
