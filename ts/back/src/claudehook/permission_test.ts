/**
 * Разбор payload'а `PermissionRequest` (`claude-hook-permission-request.md`,
 * «Ввод», «Payload → форма вопроса»): таблица требований сверху вниз и
 * подписи кнопок права (`telegram-relay-statement.md` §4).
 */

import { assertEquals } from "@std/assert";
import { type PayloadReader, permissionPayloadOf } from "./permission.ts";

/** Исход разбора словами: причина или подписи шагов. */
const WORDS: PayloadReader<string> = {
  unparsed: (what) => `вход не разобран: ${what}`,
  parsed: (request) =>
    request.asking.form([]).steps.map((step) =>
      step.options.map((option) => option.label).join(" | ")
    ).join(" / "),
};

const BASH = { command: "ls", description: "List" };

function read(payload: unknown): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return permissionPayloadOf(text).read(WORDS);
}

/** Payload с правом и транскриптом; `over` — подмена полей. */
function bash(over: Readonly<Record<string, unknown>>): unknown {
  return {
    tool_name: "Bash",
    tool_input: BASH,
    transcript_path: "/t.jsonl",
    ...over,
  };
}

/** AskUserQuestion с вопросами `questions`. */
function ask(questions: unknown): unknown {
  return bash({ tool_name: "AskUserQuestion", tool_input: { questions } });
}

const OPTIONS = [{ label: "A" }, { label: "B" }];

Deno.test("S26: требования «Ввод» сверху вниз — первое нарушенное", async (t) => {
  const cases: readonly [string, unknown, string][] = [
    ["не JSON", "{", "вход не разобран: stdin — не JSON-объект"],
    ["список", "[]", "вход не разобран: stdin — не JSON-объект"],
    ["пусто", "", "вход не разобран: stdin — не JSON-объект"],
    ["нет tool_name", {}, "вход не разобран: нет tool_name"],
    [
      "пустой tool_name",
      bash({ tool_name: "" }),
      "вход не разобран: нет tool_name",
    ],
    [
      "tool_input не объект",
      bash({ tool_input: [], transcript_path: 1 }),
      "вход не разобран: tool_input — не объект",
    ],
    ["вопросов нет", ask([]), "вход не разобран: questions"],
    [
      "пять вопросов",
      ask(Array(5).fill({ question: "?", options: OPTIONS })),
      "вход не разобран: questions",
    ],
    [
      "один вариант",
      ask([{ question: "?", options: [{ label: "A" }] }]),
      "вход не разобран: questions",
    ],
    [
      "вариант без label",
      ask([{ question: "?", options: [{ label: "A" }, {}] }]),
      "вход не разобран: questions",
    ],
    [
      "вопрос не строка",
      ask([{ question: 1, options: OPTIONS }]),
      "вход не разобран: questions",
    ],
    [
      "нет transcript_path",
      bash({ transcript_path: undefined }),
      "вход не разобран: нет transcript_path",
    ],
    ["годный", bash({ cwd: 5, session_id: [] }), "Yes | No"],
  ];
  for (const [name, payload, said] of cases) {
    await t.step(name, () => assertEquals(read(payload), said));
  }
});

Deno.test("подписи кнопок права (§4 постановки)", async (t) => {
  const rule = (toolName: string, ruleContent?: string) =>
    ruleContent === undefined ? { toolName } : { toolName, ruleContent };
  const cases: readonly [string, unknown, string][] = [
    ["нет подсказок", undefined, "Yes | No"],
    [
      "одно правило",
      [{ type: "addRules", rules: [rule("Bash", "touch /tmp/x1.txt")] }],
      "Yes | Yes, always: Bash(touch /tmp/x1.txt) | No",
    ],
    [
      "два правила в одной подсказке",
      [{ type: "addRules", rules: [rule("Bash", "a"), rule("Bash", "b")] }],
      "Yes | Yes, always: Bash(a), Bash(b) | No",
    ],
    [
      "две подсказки",
      [
        { type: "addRules", rules: [rule("Bash", "a")] },
        { type: "addRules", rules: [rule("Read", "//dev/**")] },
      ],
      "Yes | Yes, always: Bash(a) | Yes, always: Read(//dev/**) | No",
    ],
    [
      "без ruleContent",
      [{ type: "addRules", rules: [rule("Read")] }],
      "Yes | Yes, always: Read | No",
    ],
    [
      "каталог",
      [{ type: "addDirectories", directories: ["/home/user/x"] }],
      "Yes | Yes, always: dir /home/user/x | No",
    ],
    [
      "неизвестный вид",
      [{ type: "setMode", mode: "acceptEdits" }],
      "Yes | Yes, always: setMode | No",
    ],
    [
      "незнакомое без type — нет кнопки",
      [{ rules: [] }, 7],
      "Yes | No",
    ],
    ["не список — как нет", { type: "addRules" }, "Yes | No"],
  ];
  for (const [name, suggestions, said] of cases) {
    await t.step(
      name,
      () =>
        assertEquals(read(bash({ permission_suggestions: suggestions })), said),
    );
  }
});

Deno.test("текст шага права: описание, затем команда, иначе вход JSON", async (t) => {
  const textOf = (input: unknown) =>
    permissionPayloadOf(JSON.stringify(bash({ tool_input: input }))).read({
      unparsed: (what) => what,
      parsed: (request) => request.asking.form([]).steps[0].text,
    });
  await t.step("Bash", () => assertEquals(textOf(BASH), "List\nls"));
  await t.step(
    "без описания",
    () => assertEquals(textOf({ command: "ls" }), "ls"),
  );
  await t.step("не Bash", () =>
    assertEquals(
      textOf({ file_path: "/a", description: "Edit" }),
      'Edit\n{"file_path":"/a","description":"Edit"}',
    ));
});

Deno.test("AskUserQuestion без header — «Вопрос»; описания вариантов — строками", () => {
  const form = permissionPayloadOf(JSON.stringify(ask([{
    question: "Какой?",
    options: [{ label: "A", description: "буква" }, { label: "B" }],
  }]))).read({
    unparsed: () => undefined,
    parsed: (request) => request.asking.form(["ozon"]),
  });
  assertEquals(
    form?.title.line(form.steps[0].head, 1, 1),
    "❓ Вопрос — ozon",
  );
  assertEquals(form?.steps[0].options, [
    { label: "A", description: "буква" },
    { label: "B" },
  ]);
});
