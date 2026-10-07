import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import type { Command, CommandIo } from "../command/mod.ts";
import {
  formatCommandError,
  UsageError,
  VerbatimUsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  runTelegramSearch,
  type SearchSession,
  type TelegramSearchArgs,
  telegramSearchCommand,
} from "./cmd_search.ts";
import { SCAN_CAP } from "./search.ts";
import { foundMessage, type RawMessage } from "./message.ts";
import { noFile } from "./message_file.ts";

const command: Command = telegramSearchCommand;

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-search/${name}`, import.meta.url),
    "utf8",
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
    file: noFile(4821),
    entities: [],
  },
];

it("пустая выдача — пустой массив, не ошибка", async () => {
  expect(
    command.renderResult(
      {
        messages: [],
        more: false,
        scanCapped: false,
        table: false,
      },
      [],
    ),
  ).toStrictEqual(await golden("search-empty-stdout.txt"));
});

it("--table печатает таблицу тех же данных", async () => {
  const text = command.renderResult(
    {
      messages: FOUND.map(foundMessage),
      more: false,
      scanCapped: false,
      table: true,
    },
    ["--table"],
  );
  expect(text.endsWith("(1 messages)\n")).toBe(true);
  expect(
    command.renderResult(
      { messages: [], more: false, scanCapped: false, table: true },
      ["--table"],
    ),
  ).toStrictEqual(await golden("search-empty-table-stdout.txt"));
});

describe("отказы ввода отбиваются до сети", () => {
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
    it(name, async () => {
      const err = await command.invoke(argv, io()).then(
        () => null,
        (e: unknown) => e,
      );
      assert(
        err instanceof VerbatimUsageError,
        "ожидался отказ VerbatimUsageError",
      );
      // Строка слоя печатается дословно, без префикса команды.
      expect(`${err.message}\n`).toStrictEqual(await golden(file));
    });
  }
});

it("строка отказа по --limit совпадает с голденом", async () => {
  const err = await rejected(
    () => command.invoke(["выгрузка", "--limit", "0"], io()),
    UsageError,
  );
  expect(`${formatCommandError(command.errorName, err)}\n`).toStrictEqual(
    await golden("err-limit-stderr.txt"),
  );
});

it("описание укладывается в предел клиента", () => {
  // Описание тула клиент обрезает на 2048 байтах молча, а кириллица —
  // два байта на символ (`platform/mcp-server.md`, «Объём»).
  const bytes = new TextEncoder().encode(
    `${telegramSearchCommand.summary}\n\n${telegramSearchCommand.help}`,
  ).length;
  expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
});

describe("объявление команды", () => {
  it("путь и класс", () => {
    expect(command.path).toStrictEqual(["telegram", "search"]);
    // Подкоманда только читает, поэтому публикуется в профиле `ro`.
    expect(command.policy).toBe("ro");
    expect(command.errorName).toBe("telegram search");
  });
  it("формы записи в argv", () => {
    expect(
      command.parseArgs(["выгрузка", "--chat", "me", "--table"]),
    ).toStrictEqual({
      query: "выгрузка",
      chat: "me",
      from: "",
      limit: "50",
      table: true,
    });
  });
});

describe("оборванный потолком скан уезжает в результат, а не только в ход", () => {
  // Агент, вызвавший тул, строк хода не видит: до этой правки признак
  // «есть ещё» доставался только человеку в терминале, и выдача короче
  // `--limit` была неотличима от «совпадений больше нет».
  const scanned = (matchEvery: number) =>
    async function* (): AsyncIterable<RawMessage> {
      for (let id = 1; id <= SCAN_CAP + 10; id += 1) {
        const chat = {
          peerType: "chat" as const,
          rawId: 101,
          title: "Чат",
          username: null,
        };
        yield await Promise.resolve({
          id,
          chat,
          sender:
            id % matchEvery === 0
              ? {
                  peerType: "user" as const,
                  rawId: 500001,
                  title: "Иван",
                  username: null,
                }
              : chat,
          date: new Date("2026-08-16T07:54:28.000Z"),
          text: "текст",
          file: noFile(0),
          entities: [],
        });
      }
    };
  const session = (matchEvery: number): SearchSession => ({
    resolve: (peer: { kind: string; id?: number }) =>
      Promise.resolve({ ref: peer, id: 500001 }),
    searchChats: () => Promise.resolve([]),
    searchInChat: () => Promise.reject(new Error("не ожидался")),
    searchGlobal: scanned(matchEvery),
    close: () => Promise.resolve(),
  });
  const io = makeFakeIo({ progress: () => {} });
  // Глобальный поиск по отправителю требует текста запроса.
  const argv = ["выгрузка", "--from", "500001", "--limit", "50"];
  it("скан оборван потолком — сказано", async () => {
    const result = await runTelegramSearch(
      // `parseArgs` реестра отдаёт стёртый `Record`: конкретный тип
      // аргументов знает только объявление команды.
      command.parseArgs(argv) as TelegramSearchArgs,
      io,
      { openSession: () => Promise.resolve(session(500)) },
    );
    expect(result.scanCapped).toBe(true);
    expect(result.more, "оборванный скан — это «есть ещё»").toBe(true);
  });
  it("совпадений набралось — потолка не было", async () => {
    const result = await runTelegramSearch(
      command.parseArgs(argv) as TelegramSearchArgs,
      io,
      { openSession: () => Promise.resolve(session(2)) },
    );
    expect(result.scanCapped).toBe(false);
    // Выдача упёрлась в `--limit`: потолка не было, а совпадения за
    // ним остаться могли — это тоже «есть ещё», и молчать о нём
    // нельзя.
    expect(result.messages.length).toBe(50);
    expect(result.more, "набранный `--limit` — это «есть ещё»").toBe(true);
  });
});
