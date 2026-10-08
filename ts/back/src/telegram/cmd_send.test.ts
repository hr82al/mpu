import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import type { Command, CommandIo } from "@mpu/command";
import {
  formatCommandError,
  NotFoundIoError,
  UsageError,
  VerbatimUsageError,
} from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import { telegramSendCommand } from "./cmd_send.ts";

const command: Command = telegramSendCommand;

/** Голден канала: копия лежит рядом с тестом (`testdata/telegram-send/`). */
async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-send/${name}`, import.meta.url),
    "utf8",
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

it("строка вывода: текст в «Избранное»", async () => {
  expect(
    render({
      id: 5000001,
      chat_id: 100000001,
      date: "2026-08-16T08:04:09+00:00",
    }),
  ).toStrictEqual(await golden("send-text-stdout.txt"));
});

it("строка вывода: документ с подписью", async () => {
  expect(
    render({
      id: 5000002,
      chat_id: 100000001,
      date: "2026-08-16T08:04:11+00:00",
    }),
  ).toStrictEqual(await golden("send-file-stdout.txt"));
});

it("строка вывода: альбом из двух документов", async () => {
  expect(
    render({
      id: 5000004,
      chat_id: 100000001,
      date: "2026-08-16T08:04:12+00:00",
    }),
  ).toStrictEqual(await golden("send-album-stdout.txt"));
});

it("времени нет — в строке литеральный null", () => {
  expect(render({ id: 5000001, chat_id: 100000001, date: null })).toBe(
    '{"id": 5000001, "chat_id": 100000001, "date": null}\n',
  );
});

it("юникод в строке вывода не экранируется", () => {
  // Ключи фиксированы, но проверка защищает выбор сборки строки: JSON с
  // экранированием кириллицы разошёлся бы с голденом на первом же чате.
  expect(
    render({ id: 1, chat_id: 2, date: "2026-08-16T08:04:09+00:00" }).includes(
      "\\u",
    ),
  ).toBe(false);
});

it("пустой текст без вложений — отказ до сети", async () => {
  const err = await command
    .invoke([""], io({ TELEGRAM_DEFAULT_CHAT: "me" }))
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  expect(err.message).toBe("telegram: пустой текст сообщения");
  expect(`${err.message}\n`).toStrictEqual(
    await golden("err-empty-text-stderr.txt"),
  );
});

it("строка stderr идёт без префикса команды", async () => {
  const err = await command
    .invoke([""], io({ TELEGRAM_DEFAULT_CHAT: "me" }))
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  // Форму строки задаёт слой (`telegram: <причина>`), а не точка входа:
  // общий префикс `mpu telegram send: ` развалил бы голден.
  expect(`${formatCommandError(command.errorName, err)}\n`).toStrictEqual(
    await golden("err-empty-text-stderr.txt"),
  );
});

it("адресат не задан — отказ до сети", async () => {
  const err = await command.invoke(["привет"], io()).then(
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

it("вложения нет — отказ до сети, ключевой текст в сообщении", async () => {
  const err = await rejected(
    () =>
      command.invoke(
        ["привет", "-f", "/no/such/file"],
        io({ TELEGRAM_DEFAULT_CHAT: "me" }),
      ),
    UsageError,
  );
  expect(err.message).toBe("файл-вложение не найден: /no/such/file");
  // Рамка здесь общая для всего CLI (`mpu <команда>: …`), а не своя,
  // как у отказов слоя: вложение отбивает разбор аргументов.
  expect(`${formatCommandError(command.errorName, err)}\n`).toStrictEqual(
    await golden("err-file-missing-stderr.txt"),
  );
});

describe("объявление команды", () => {
  it("путь и класс", () => {
    expect(command.path).toStrictEqual(["telegram", "send"]);
    expect(command.policy).toBe("rw");
    expect(command.errorName).toBe("telegram send");
  });
  it("формы записи в argv", () => {
    expect(
      command.parseArgs(["привет", "--chat", "me", "--md", "-f", "/tmp/a"]),
    ).toStrictEqual({
      message: "привет",
      chat: "me",
      md: true,
      file: ["/tmp/a"],
    });
  });
});
