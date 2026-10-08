import { assert, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { NotFoundIoError, UsageError } from "@mpu/command";
import { VerbatimUsageError } from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import { type PlanIo, sendPlan } from "./plan.ts";

const FILES: Readonly<Record<string, string>> = {
  "/tmp/a.txt": "первый",
  "/tmp/dir/b.txt": "второй",
};

function io(stdin?: string): PlanIo {
  return makeFakeIo({
    readStdin:
      stdin === undefined
        ? undefined
        : () => Promise.resolve(new TextEncoder().encode(stdin)),
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

it("адресат из флага старше значения env-файла", async () => {
  const plan = await sendPlan(args({ chat: "@durov" }), io(), "me");
  expect(plan.target).toBe("@durov");
  expect(plan.peer).toStrictEqual({ kind: "name", name: "durov" });
});

it("адресат берётся из env-файла, когда флага нет", async () => {
  const plan = await sendPlan(args(), io(), "me");
  expect(plan.target).toBe("me");
  expect(plan.peer).toStrictEqual({ kind: "me" });
});

it("адресата нет ни во флаге, ни в env-файле", async () => {
  const err = await sendPlan(args(), io(), undefined).then(
    () => null,
    (e: unknown) => e,
  );
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  expect(err.message).toBe(
    "telegram: адресат не задан; укажи --chat или TELEGRAM_DEFAULT_CHAT в .env",
  );
});

it("'-' означает весь stdin", async () => {
  const plan = await sendPlan(args({ message: "-" }), io("из пайпа\n"), "me");
  expect(plan.text).toBe("из пайпа\n");
});

describe("пустой текст без вложений — ошибка ввода", () => {
  for (const [name, patch, stdin] of [
    ["пустая строка", { message: "" }, undefined],
    ["пустой stdin", { message: "-" }, ""],
  ] as const) {
    it(name, async () => {
      const err = await sendPlan(args(patch), io(stdin), "me").then(
        () => null,
        (e: unknown) => e,
      );
      assert(
        err instanceof VerbatimUsageError,
        "ожидался отказ VerbatimUsageError",
      );
      expect(err.message).toBe("telegram: пустой текст сообщения");
    });
  }
});

it("пустой текст с вложением — документ без подписи", async () => {
  const plan = await sendPlan(
    args({ message: "", file: ["/tmp/a.txt"] }),
    io(),
    "me",
  );
  expect(plan.text).toBe("");
  expect(plan.attachments.map((file) => file.name)).toStrictEqual(["a.txt"]);
});

it("текст из одних пробелов подписью не становится", async () => {
  const plan = await sendPlan(
    args({ message: "   \n", file: ["/tmp/a.txt"] }),
    io(),
    "me",
  );
  expect(plan.text).toBe("");
});

it("порядок вложений равен порядку флагов", async () => {
  const plan = await sendPlan(
    args({ file: ["/tmp/dir/b.txt", "/tmp/a.txt"] }),
    io(),
    "me",
  );
  expect(plan.attachments.map((file) => file.name)).toStrictEqual([
    "b.txt",
    "a.txt",
  ]);
  expect(new TextDecoder().decode(plan.attachments[1].bytes)).toBe("первый");
});

it("вложение не найдено — отказ до сети", async () => {
  const err = await rejected(
    () => sendPlan(args({ file: ["/no/such/file"] }), io(), "me"),
    UsageError,
  );
  expect(err.message).toBe("файл-вложение не найден: /no/such/file");
});

it("вложения проверяются раньше адресата и текста", async () => {
  const err = await rejected(
    () =>
      sendPlan(args({ message: "", file: ["/no/such/file"] }), io(), undefined),
    UsageError,
  );
  expect(err.message).toBe("файл-вложение не найден: /no/such/file");
});

it("вложение не читается по иной причине — тоже отказ ввода", async () => {
  const failing = makeFakeIo({
    readRegularFile: () => Promise.reject(new Error("permission denied")),
  });
  const err = await rejected(
    () => sendPlan(args({ file: ["/tmp/a.txt"] }), failing, "me"),
    UsageError,
  );
  expect(err.message).toBe(
    "не удалось прочитать вложение /tmp/a.txt: permission denied",
  );
});

it("имя вложения — базовое имя пути", async () => {
  const plan = await sendPlan(args({ file: ["/tmp/dir/b.txt"] }), io(), "me");
  expect(plan.attachments[0].name).toBe("b.txt");
});

it("--md переносится в план", async () => {
  expect((await sendPlan(args({ md: true }), io(), "me")).markdown).toBe(true);
});
