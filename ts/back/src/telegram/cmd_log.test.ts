/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`): разбор
 * ввода. Сеть не задействована — проверяется всё, что решается до неё.
 */

import { mkdtemp, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import type { Command, CommandIo } from "../command/mod.ts";
import {
  formatCommandError,
  NotFoundIoError,
  UsageError,
  VerbatimUsageError,
} from "../command/mod.ts";
import { makeDenoIo } from "../runtime/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { CAPTION_LIMIT, logMessage, telegramLogCommand } from "./cmd_log.ts";

const command: Command = telegramLogCommand;

/** Порт разбора ввода: stdin и вложение. */
type LogIo = Pick<CommandIo, "readStdin" | "readRegularFile">;

/** Порт чтения stdin: команда читает его только при MESSAGE = '-'. */
function io(stdin: string): LogIo {
  return {
    readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)),
    readRegularFile: () => {
      throw new Error("readRegularFile must not be touched");
    },
  };
}

/** Порт с единственным читаемым файлом; прочие пути — «не найден». */
function ioWithFile(path: string, bytes: string): LogIo {
  return {
    readStdin: () => Promise.resolve(new Uint8Array()),
    readRegularFile: (asked: string) => {
      if (asked !== path) throw new NotFoundIoError(`нет файла ${asked}`);
      return Promise.resolve(new TextEncoder().encode(bytes));
    },
  };
}

/** Голден канала: копия лежит рядом с тестом (`testdata/telegram-log/`). */
async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-log/${name}`, import.meta.url),
    "utf8",
  );
}

it("обычный текст берётся из аргумента, stdin не читается", async () => {
  let read = false;
  const message = await logMessage({ message: "заметка" }, {
    ...io(""),
    readStdin: () => {
      read = true;
      return Promise.resolve(new Uint8Array());
    },
  });
  expect(message).toStrictEqual({ kind: "text", text: "заметка" });
  expect(read).toBe(false);
});

it("дефис означает весь stdin", async () => {
  expect(await logMessage({ message: "-" }, io("две\nстроки\n"))).toStrictEqual(
    {
      kind: "text",
      text: "две\nстроки\n",
    },
  );
});

it("пустой аргумент — ошибка ввода", async () => {
  const failure = logMessage({ message: "" }, io(""));
  await expect(failure).rejects.toThrow(VerbatimUsageError);
  await expect(failure).rejects.toThrow("нужен непустой MESSAGE");
});

it("пустой stdin — та же ошибка ввода", async () => {
  const failure = logMessage({ message: "-" }, io("   \n"));
  await expect(failure).rejects.toThrow(VerbatimUsageError);
  await expect(failure).rejects.toThrow("нужен непустой MESSAGE");
});

it("строка вывода: заметка отправлена", async () => {
  expect(command.renderResult({ id: 5000001 }, ["заметка"])).toStrictEqual(
    await golden("log-stdout.txt"),
  );
});

it("пустой текст — отказ до сети", async () => {
  const err = await command.invoke([""], makeFakeIo()).then(
    () => null,
    (e: unknown) => e,
  );
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  expect(err.message).toBe("telegram: нужен непустой MESSAGE");
  expect(`${err.message}\n`).toStrictEqual(
    await golden("err-empty-text-stderr.txt"),
  );
});

it("строка stderr идёт без префикса команды", async () => {
  const err = await command.invoke([""], makeFakeIo()).then(
    () => null,
    (e: unknown) => e,
  );
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  // Форму строки задаёт слой (`telegram: <причина>`), а не точка входа:
  // общий префикс `mpu telegram log: ` развалил бы голден.
  expect(`${formatCommandError(command.errorName, err)}\n`).toStrictEqual(
    await golden("err-empty-text-stderr.txt"),
  );
});

it("файл задан — документ с подписью и базовым именем", async () => {
  const message = await logMessage(
    { message: "разбор за среду", file: "/home/me/notes/разбор.md" },
    ioWithFile("/home/me/notes/разбор.md", "# разбор\n"),
  );
  expect(message).toStrictEqual({
    kind: "document",
    caption: "разбор за среду",
    file: {
      name: "разбор.md",
      bytes: new TextEncoder().encode("# разбор\n"),
    },
  });
});

it("пустой MESSAGE допустим вместе с -f: документ без подписи", async () => {
  const message = await logMessage(
    { message: "  ", file: "/tmp/a.md" },
    ioWithFile("/tmp/a.md", "x"),
  );
  expect(message.kind).toBe("document");
  expect(message.kind === "document" ? message.caption : "нет").toBe("");
});

it("stdin сочетается с -f: текст становится подписью", async () => {
  const message = await logMessage(
    { message: "-", file: "/tmp/a.md" },
    {
      ...ioWithFile("/tmp/a.md", "x"),
      readStdin: () => Promise.resolve(new TextEncoder().encode("из пайпа\n")),
    },
  );
  expect(message.kind === "document" ? message.caption : "нет").toBe(
    "из пайпа\n",
  );
});

describe("подпись на границе предела: 1024 проходит, 1025 нет", () => {
  const io = ioWithFile("/tmp/a.md", "x");
  it("ровно предел", async () => {
    const caption = "я".repeat(CAPTION_LIMIT);
    const message = await logMessage(
      { message: caption, file: "/tmp/a.md" },
      io,
    );
    expect(message.kind === "document" ? message.caption : "нет").toStrictEqual(
      caption,
    );
  });
  it("предел плюс один символ", async () => {
    const err = await logMessage(
      { message: "я".repeat(CAPTION_LIMIT + 1), file: "/tmp/a.md" },
      io,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    assert(
      err instanceof VerbatimUsageError,
      "ожидался отказ VerbatimUsageError",
    );
    // Оба числа в тексте: сколько есть и сколько можно.
    expect(err.message).toBe(
      "telegram: подпись длиннее предела Bot API: 1025 символов, можно 1024",
    );
    expect(`${err.message}\n`).toStrictEqual(
      await golden("err-caption-long-stderr.txt"),
    );
  });
});

it("текст сообщения предел подписи не задевает", async () => {
  const text = "я".repeat(CAPTION_LIMIT + 1);
  expect(await logMessage({ message: text }, io(""))).toStrictEqual({
    kind: "text",
    text,
  });
});

it("отсутствующий файл — отказ до сети, с путём на экране", async () => {
  const err = await logMessage(
    { message: "текст", file: "/no/such/file" },
    ioWithFile("/tmp/a.md", "x"),
  ).then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof UsageError, "ожидался отказ UsageError");
  expect(err.message).toBe("файл-вложение не найден: /no/such/file");
  expect(`${formatCommandError(command.errorName, err)}\n`).toStrictEqual(
    await golden("err-file-missing-stderr.txt"),
  );
});

it("каталог вместо файла — тот же отказ, не падение чтения", async () => {
  // Порт настоящий: «каталог вместо файла» отбивает именно он
  // (`readRegularFile`), и проверять это на фейке нечего.
  const real = makeDenoIo("/nowhere");
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const err = await logMessage({ message: "текст", file: dir }, real).then(
      () => null,
      (e: unknown) => e,
    );
    assert(err instanceof UsageError, "ожидался отказ UsageError");
    expect(err.message).toStrictEqual(`файл-вложение не найден: ${dir}`);
  } finally {
    await rmdir(dir);
  }
});

it("повтор -f — ошибка ввода, а не молчаливое схлопывание", async () => {
  const err = await command.invoke(
    ["текст", "-f", "a.md", "-f", "b.md"],
    makeFakeIo(),
  ).then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof UsageError, "ожидался отказ UsageError");
  expect(err.message).toBe("option --file may be given only once");
  // Путь в тексте не эхо-печатается: он ушёл бы в секцию err журнала.
  expect(err.message.includes("a.md")).toBe(false);
});
