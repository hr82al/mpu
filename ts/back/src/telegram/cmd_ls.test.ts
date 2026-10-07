import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import type { Command, CommandIo } from "../command/mod.ts";
import { formatCommandError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { RawChat } from "./chat.ts";
import { telegramLsCommand } from "./cmd_ls.ts";

const command: Command = telegramLsCommand;

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-ls/${name}`, import.meta.url),
    "utf8",
  );
}

const DIALOGS: readonly RawChat[] = [
  {
    peerType: "user",
    rawId: 100000001,
    title: "Иван Петров",
    username: "ipetrov",
  },
  {
    peerType: "bot",
    rawId: 100000002,
    title: "Бот сборок",
    username: "build_bot",
  },
  { peerType: "channel", rawId: 3, title: "Канал релизов", username: null },
];

function io(): CommandIo {
  return makeFakeIo({});
}

it("вывод JSON собирается из выдачи клиента", async () => {
  expect(command.renderResult({
    dialogs: dialogsOf(DIALOGS),
    more: false,
    table: false,
  }, [])).toStrictEqual(await golden("ls-json-stdout.txt"));
});

it("пустая выдача — пустой массив, не ошибка", async () => {
  expect(command.renderResult({ dialogs: [], more: false, table: false }, []))
    .toStrictEqual(await golden("ls-empty-stdout.txt"));
});

it("--table печатает таблицу тех же данных", async () => {
  const text = command.renderResult(
    { dialogs: dialogsOf(DIALOGS), more: false, table: true },
    ["--table"],
  );
  expect(text.endsWith("(3 dialogs)\n")).toBe(true);
  expect(command.renderResult({ dialogs: [], more: false, table: true }, [
    "--table",
  ])).toStrictEqual(await golden("ls-empty-table-stdout.txt"));
});

describe("--limit вне диапазона — отказ до сети", () => {
  for (const value of ["0", "501", "-1"]) {
    it(value, async () => {
      const err = await command.invoke(["--limit", value], io()).then(
        () => null,
        (e: unknown) => e,
      );
      assert(err instanceof UsageError, "ожидался отказ UsageError");
      expect(err.message).toStrictEqual(
        `--limit вне диапазона 1..500: ${value}`,
      );
    });
  }
});

it("строка отказа по --limit совпадает с голденом", async () => {
  const err = await command.invoke(["--limit", "0"], io()).then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof UsageError, "ожидался отказ UsageError");
  expect(`${formatCommandError(command.errorName, err)}\n`).toStrictEqual(
    await golden("err-limit-stderr.txt"),
  );
});

it("нечисловой --limit тоже отбивается", async () => {
  const err = await command.invoke(["--limit", "много"], io()).then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof UsageError, "ожидался отказ UsageError");
  expect(err.message).toBe("--limit вне диапазона 1..500: много");
});

describe("объявление команды", () => {
  it("путь и класс", () => {
    expect(command.path).toStrictEqual(["telegram", "ls"]);
    // Подкоманда только читает, поэтому публикуется в профиле `ro`.
    expect(command.policy).toBe("ro");
    expect(command.errorName).toBe("telegram ls");
  });
  it("формы записи в argv", () => {
    expect(command.parseArgs(["Команда", "--table"])).toStrictEqual({
      query: "Команда",
      limit: "50",
      table: true,
    });
  });
  it("адресата команда не принимает", () => {
    expect(command.inputs.map((input) => input.name).includes("chat")).toBe(
      false,
    );
  });
});

/** Диалоги в форме результата команды. */
function dialogsOf(chats: readonly RawChat[]) {
  return chats.map((chat) => ({
    id: chat.peerType === "channel"
      ? -(1000000000000 + chat.rawId)
      : chat.rawId,
    title: chat.title,
    kind: chat.peerType === "channel" ? "channel" : chat.peerType,
    username: chat.username,
  }));
}
