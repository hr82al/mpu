import { assertEquals, assertRejects } from "@std/assert";
import type { Command, CommandIo } from "../command/mod.ts";
import {
  formatCommandError,
  UsageError,
  VerbatimUsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { telegramSearchCommand } from "./cmd_search.ts";
import { foundMessage, type RawMessage } from "./message.ts";

const command: Command = telegramSearchCommand;

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-search/${name}`, import.meta.url),
  );
}

function io(): CommandIo {
  return makeFakeIo({});
}

const FOUND: readonly RawMessage[] = [
  {
    id: 4821,
    chat: {
      peerType: "supergroup",
      rawId: 101,
      title: "Команда выгрузок",
      username: "team_uploads",
    },
    sender: {
      peerType: "user",
      rawId: 500001,
      title: "Иван Петров",
      username: "ipetrov",
    },
    date: new Date("2026-08-16T07:54:28.000Z"),
    text: "выгрузка за июль готова",
  },
];

Deno.test("пустая выдача — пустой массив, не ошибка", async () => {
  assertEquals(
    command.renderResult({ messages: [], table: false }, []),
    await golden("search-empty-stdout.txt"),
  );
});

Deno.test("--table печатает таблицу тех же данных", async () => {
  const text = command.renderResult(
    { messages: FOUND.map(foundMessage), table: true },
    ["--table"],
  );
  assertEquals(text.endsWith("(1 messages)\n"), true);
  assertEquals(
    command.renderResult({ messages: [], table: true }, ["--table"]),
    await golden("search-empty-table-stdout.txt"),
  );
});

Deno.test("отказы ввода отбиваются до сети", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly argv: readonly string[];
    readonly golden: string;
  }[] = [
    {
      name: "пустой глобальный поиск",
      argv: [],
      golden: "err-empty-query-stderr.txt",
    },
    {
      name: "--from без --chat и без запроса",
      argv: ["--from", "@ivan"],
      golden: "err-from-without-chat-stderr.txt",
    },
  ];
  for (const { name, argv, golden: file } of cases) {
    await t.step(name, async () => {
      const err = await assertRejects(
        () => command.invoke(argv, io()),
        VerbatimUsageError,
      );
      // Строка слоя печатается дословно, без префикса команды.
      assertEquals(`${err.message}\n`, await golden(file));
    });
  }
});

Deno.test("строка отказа по --limit совпадает с голденом", async () => {
  const err = await assertRejects(
    () => command.invoke(["выгрузка", "--limit", "0"], io()),
    UsageError,
  );
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-limit-stderr.txt"),
  );
});

Deno.test("объявление команды", async (t) => {
  await t.step("путь и класс", () => {
    assertEquals(command.path, ["telegram", "search"]);
    // Подкоманда только читает, поэтому публикуется в профиле `ro`.
    assertEquals(command.policy, "ro");
    assertEquals(command.errorName, "telegram search");
  });
  await t.step("формы записи в argv", () => {
    assertEquals(
      command.parseArgs(["выгрузка", "--chat", "me", "--table"]),
      {
        query: "выгрузка",
        chat: "me",
        from: "",
        limit: "50",
        table: true,
      },
    );
  });
});
