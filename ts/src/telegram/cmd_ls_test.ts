import { assertEquals, assertRejects } from "@std/assert";
import type { Command, CommandIo } from "../command/mod.ts";
import { formatCommandError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { RawChat } from "./chat.ts";
import { telegramLsCommand } from "./cmd_ls.ts";

const command: Command = telegramLsCommand;

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-ls/${name}`, import.meta.url),
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

Deno.test("вывод JSON собирается из выдачи клиента", async () => {
  assertEquals(
    command.renderResult({ dialogs: dialogsOf(DIALOGS), table: false }, []),
    await golden("ls-json-stdout.txt"),
  );
});

Deno.test("пустая выдача — пустой массив, не ошибка", async () => {
  assertEquals(
    command.renderResult({ dialogs: [], table: false }, []),
    await golden("ls-empty-stdout.txt"),
  );
});

Deno.test("--table печатает таблицу тех же данных", async () => {
  const text = command.renderResult(
    { dialogs: dialogsOf(DIALOGS), table: true },
    ["--table"],
  );
  assertEquals(text.endsWith("(3 dialogs)\n"), true);
  assertEquals(
    command.renderResult({ dialogs: [], table: true }, ["--table"]),
    await golden("ls-empty-table-stdout.txt"),
  );
});

Deno.test("--limit вне диапазона — отказ до сети", async (t) => {
  for (const value of ["0", "501", "-1"]) {
    await t.step(value, async () => {
      const err = await assertRejects(
        () => command.invoke(["--limit", value], io()),
        UsageError,
      );
      assertEquals(err.message, `--limit вне диапазона 1..500: ${value}`);
    });
  }
});

Deno.test("строка отказа по --limit совпадает с голденом", async () => {
  const err = await assertRejects(
    () => command.invoke(["--limit", "0"], io()),
    UsageError,
  );
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-limit-stderr.txt"),
  );
});

Deno.test("нечисловой --limit тоже отбивается", async () => {
  const err = await assertRejects(
    () => command.invoke(["--limit", "много"], io()),
    UsageError,
  );
  assertEquals(err.message, "--limit вне диапазона 1..500: много");
});

Deno.test("объявление команды", async (t) => {
  await t.step("путь и класс", () => {
    assertEquals(command.path, ["telegram", "ls"]);
    // Подкоманда только читает, поэтому публикуется в профиле `ro`.
    assertEquals(command.policy, "ro");
    assertEquals(command.errorName, "telegram ls");
  });
  await t.step("формы записи в argv", () => {
    assertEquals(command.parseArgs(["Команда", "--table"]), {
      query: "Команда",
      limit: "50",
      table: true,
    });
  });
  await t.step("адресата команда не принимает", () => {
    assertEquals(
      command.inputs.map((input) => input.name).includes("chat"),
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
