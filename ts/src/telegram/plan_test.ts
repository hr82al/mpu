import { assertEquals, assertRejects } from "@std/assert";
import { NotFoundIoError, UsageError } from "../command/mod.ts";
import { VerbatimUsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type PlanIo, sendPlan } from "./plan.ts";

const FILES: Readonly<Record<string, string>> = {
  "/tmp/a.txt": "первый",
  "/tmp/dir/b.txt": "второй",
};

function io(stdin?: string): PlanIo {
  return makeFakeIo({
    readTextStdin: stdin === undefined
      ? undefined
      : () => Promise.resolve(stdin),
    readRegularFile: (path: string) => {
      const text = FILES[path];
      if (text === undefined) {
        return Promise.reject(new NotFoundIoError(`no such file: ${path}`));
      }
      return Promise.resolve(new TextEncoder().encode(text));
    },
  });
}

function args(patch: Record<string, unknown> = {}) {
  return {
    message: "привет",
    chat: undefined,
    md: false,
    file: [],
    ...patch,
  } as Parameters<typeof sendPlan>[0];
}

Deno.test("адресат из флага старше значения env-файла", async () => {
  const plan = await sendPlan(args({ chat: "@durov" }), io(), "me");
  assertEquals(plan.target, "@durov");
  assertEquals(plan.peer, { kind: "name", name: "durov" });
});

Deno.test("адресат берётся из env-файла, когда флага нет", async () => {
  const plan = await sendPlan(args(), io(), "me");
  assertEquals(plan.target, "me");
  assertEquals(plan.peer, { kind: "me" });
});

Deno.test("адресата нет ни во флаге, ни в env-файле", async () => {
  const err = await assertRejects(
    () => sendPlan(args(), io(), undefined),
    VerbatimUsageError,
  );
  assertEquals(
    err.message,
    "telegram: адресат не задан; укажи --chat или TELEGRAM_DEFAULT_CHAT в .env",
  );
});

Deno.test("'-' означает весь stdin", async () => {
  const plan = await sendPlan(args({ message: "-" }), io("из пайпа\n"), "me");
  assertEquals(plan.text, "из пайпа\n");
});

Deno.test("пустой текст без вложений — ошибка ввода", async (t) => {
  for (
    const [name, patch, stdin] of [
      ["пустая строка", { message: "" }, undefined],
      ["пустой stdin", { message: "-" }, ""],
    ] as const
  ) {
    await t.step(name, async () => {
      const err = await assertRejects(
        () => sendPlan(args(patch), io(stdin), "me"),
        VerbatimUsageError,
      );
      assertEquals(err.message, "telegram: пустой текст сообщения");
    });
  }
});

Deno.test("пустой текст с вложением — документ без подписи", async () => {
  const plan = await sendPlan(
    args({ message: "", file: ["/tmp/a.txt"] }),
    io(),
    "me",
  );
  assertEquals(plan.text, "");
  assertEquals(plan.attachments.map((file) => file.name), ["a.txt"]);
});

Deno.test("текст из одних пробелов подписью не становится", async () => {
  const plan = await sendPlan(
    args({ message: "   \n", file: ["/tmp/a.txt"] }),
    io(),
    "me",
  );
  assertEquals(plan.text, "");
});

Deno.test("порядок вложений равен порядку флагов", async () => {
  const plan = await sendPlan(
    args({ file: ["/tmp/dir/b.txt", "/tmp/a.txt"] }),
    io(),
    "me",
  );
  assertEquals(plan.attachments.map((file) => file.name), ["b.txt", "a.txt"]);
  assertEquals(
    new TextDecoder().decode(plan.attachments[1].bytes),
    "первый",
  );
});

Deno.test("вложение не найдено — отказ до сети", async () => {
  const err = await assertRejects(
    () => sendPlan(args({ file: ["/no/such/file"] }), io(), "me"),
    UsageError,
  );
  assertEquals(err.message, "файл-вложение не найден: /no/such/file");
});

Deno.test("вложения проверяются раньше адресата и текста", async () => {
  const err = await assertRejects(
    () =>
      sendPlan(args({ message: "", file: ["/no/such/file"] }), io(), undefined),
    UsageError,
  );
  assertEquals(err.message, "файл-вложение не найден: /no/such/file");
});

Deno.test("вложение не читается по иной причине — тоже отказ ввода", async () => {
  const failing = makeFakeIo({
    readRegularFile: () => Promise.reject(new Error("permission denied")),
  });
  const err = await assertRejects(
    () => sendPlan(args({ file: ["/tmp/a.txt"] }), failing, "me"),
    UsageError,
  );
  assertEquals(
    err.message,
    "не удалось прочитать вложение /tmp/a.txt: permission denied",
  );
});

Deno.test("имя вложения — базовое имя пути", async () => {
  const plan = await sendPlan(
    args({ file: ["/tmp/dir/b.txt"] }),
    io(),
    "me",
  );
  assertEquals(plan.attachments[0].name, "b.txt");
});

Deno.test("--md переносится в план", async () => {
  assertEquals((await sendPlan(args({ md: true }), io(), "me")).markdown, true);
});
