import { assertEquals, assertRejects } from "@std/assert";
import type { Command, CommandIo } from "../command/mod.ts";
import {
  formatCommandError,
  NotFoundIoError,
  UsageError,
  VerbatimUsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { telegramSendCommand } from "./cmd_send.ts";

const command: Command = telegramSendCommand;

/** Голден канала: копия лежит рядом с тестом (`testdata/telegram-send/`). */
async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-send/${name}`, import.meta.url),
  );
}

function render(result: unknown): string {
  return command.renderResult(result, ["привет"]);
}

function io(env: Readonly<Record<string, string>> = {}): CommandIo {
  return makeFakeIo({
    // Файлов в стенде нет вовсе: вызов с вложением обязан отбиться до
    // сети, а не дойти до сеанса.
    readRegularFile: (path: string) =>
      Promise.reject(new NotFoundIoError(`no such file: ${path}`)),
    envFile: {
      get: (name) => env[name],
      values: () => env,
      require: (name) => {
        const value = env[name];
        if (value === undefined) throw new Error(`${name} must not be touched`);
        return value;
      },
      set: () => {
        throw new Error("envFile.set must not be touched");
      },
    },
  });
}

Deno.test("строка вывода: текст в «Избранное»", async () => {
  assertEquals(
    render({
      id: 5000001,
      chat_id: 100000001,
      date: "2026-08-16T08:04:09+00:00",
    }),
    await golden("send-text-stdout.txt"),
  );
});

Deno.test("строка вывода: документ с подписью", async () => {
  assertEquals(
    render({
      id: 5000002,
      chat_id: 100000001,
      date: "2026-08-16T08:04:11+00:00",
    }),
    await golden("send-file-stdout.txt"),
  );
});

Deno.test("строка вывода: альбом из двух документов", async () => {
  assertEquals(
    render({
      id: 5000004,
      chat_id: 100000001,
      date: "2026-08-16T08:04:12+00:00",
    }),
    await golden("send-album-stdout.txt"),
  );
});

Deno.test("времени нет — в строке литеральный null", () => {
  assertEquals(
    render({ id: 5000001, chat_id: 100000001, date: null }),
    '{"id": 5000001, "chat_id": 100000001, "date": null}\n',
  );
});

Deno.test("юникод в строке вывода не экранируется", () => {
  // Ключи фиксированы, но проверка защищает выбор сборки строки: JSON с
  // экранированием кириллицы разошёлся бы с голденом на первом же чате.
  assertEquals(
    render({ id: 1, chat_id: 2, date: "2026-08-16T08:04:09+00:00" }).includes(
      "\\u",
    ),
    false,
  );
});

Deno.test("пустой текст без вложений — отказ до сети", async () => {
  const err = await assertRejects(
    () => command.invoke([""], io({ TELEGRAM_DEFAULT_CHAT: "me" })),
    VerbatimUsageError,
  );
  assertEquals(err.message, "telegram: пустой текст сообщения");
  assertEquals(`${err.message}\n`, await golden("err-empty-text-stderr.txt"));
});

Deno.test("строка stderr идёт без префикса команды", async () => {
  const err = await assertRejects(
    () => command.invoke([""], io({ TELEGRAM_DEFAULT_CHAT: "me" })),
    VerbatimUsageError,
  );
  // Форму строки задаёт слой (`telegram: <причина>`), а не точка входа:
  // общий префикс `mpu telegram send: ` развалил бы голден.
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-empty-text-stderr.txt"),
  );
});

Deno.test("адресат не задан — отказ до сети", async () => {
  const err = await assertRejects(
    () => command.invoke(["привет"], io()),
    VerbatimUsageError,
  );
  assertEquals(
    err.message,
    "telegram: адресат не задан; укажи --chat или TELEGRAM_DEFAULT_CHAT в .env",
  );
});

Deno.test("вложения нет — отказ до сети, ключевой текст в сообщении", async () => {
  const err = await assertRejects(
    () =>
      command.invoke(
        ["привет", "-f", "/no/such/file"],
        io({ TELEGRAM_DEFAULT_CHAT: "me" }),
      ),
    UsageError,
  );
  assertEquals(err.message, "файл-вложение не найден: /no/such/file");
  // Рамка здесь общая для всего CLI (`mpu <команда>: …`), а не своя,
  // как у отказов слоя: вложение отбивает разбор аргументов.
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-file-missing-stderr.txt"),
  );
});

Deno.test("объявление команды", async (t) => {
  await t.step("путь и класс", () => {
    assertEquals(command.path, ["telegram", "send"]);
    assertEquals(command.policy, "rw");
    assertEquals(command.errorName, "telegram send");
  });
  await t.step("формы записи в argv", () => {
    assertEquals(
      command.parseArgs(["привет", "--chat", "me", "--md", "-f", "/tmp/a"]),
      { message: "привет", chat: "me", md: true, file: ["/tmp/a"] },
    );
  });
});
