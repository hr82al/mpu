/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`): разбор
 * ввода. Сеть не задействована — проверяется всё, что решается до неё.
 */

import { assertEquals, assertRejects } from "@std/assert";
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
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-log/${name}`, import.meta.url),
  );
}

Deno.test("обычный текст берётся из аргумента, stdin не читается", async () => {
  let read = false;
  const message = await logMessage({ message: "заметка" }, {
    ...io(""),
    readStdin: () => {
      read = true;
      return Promise.resolve(new Uint8Array());
    },
  });
  assertEquals(message, { kind: "text", text: "заметка" });
  assertEquals(read, false);
});

Deno.test("дефис означает весь stdin", async () => {
  assertEquals(await logMessage({ message: "-" }, io("две\nстроки\n")), {
    kind: "text",
    text: "две\nстроки\n",
  });
});

Deno.test("пустой аргумент — ошибка ввода", async () => {
  await assertRejects(
    () => logMessage({ message: "" }, io("")),
    VerbatimUsageError,
    "нужен непустой MESSAGE",
  );
});

Deno.test("пустой stdin — та же ошибка ввода", async () => {
  await assertRejects(
    () => logMessage({ message: "-" }, io("   \n")),
    VerbatimUsageError,
    "нужен непустой MESSAGE",
  );
});

Deno.test("строка вывода: заметка отправлена", async () => {
  assertEquals(
    command.renderResult({ id: 5000001 }, ["заметка"]),
    await golden("log-stdout.txt"),
  );
});

Deno.test("пустой текст — отказ до сети", async () => {
  const err = await assertRejects(
    () => command.invoke([""], makeFakeIo()),
    VerbatimUsageError,
  );
  assertEquals(err.message, "telegram: нужен непустой MESSAGE");
  assertEquals(`${err.message}\n`, await golden("err-empty-text-stderr.txt"));
});

Deno.test("строка stderr идёт без префикса команды", async () => {
  const err = await assertRejects(
    () => command.invoke([""], makeFakeIo()),
    VerbatimUsageError,
  );
  // Форму строки задаёт слой (`telegram: <причина>`), а не точка входа:
  // общий префикс `mpu telegram log: ` развалил бы голден.
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-empty-text-stderr.txt"),
  );
});

Deno.test("файл задан — документ с подписью и базовым именем", async () => {
  const message = await logMessage(
    { message: "разбор за среду", file: "/home/me/notes/разбор.md" },
    ioWithFile("/home/me/notes/разбор.md", "# разбор\n"),
  );
  assertEquals(message, {
    kind: "document",
    caption: "разбор за среду",
    file: {
      name: "разбор.md",
      bytes: new TextEncoder().encode("# разбор\n"),
    },
  });
});

Deno.test("пустой MESSAGE допустим вместе с -f: документ без подписи", async () => {
  const message = await logMessage(
    { message: "  ", file: "/tmp/a.md" },
    ioWithFile("/tmp/a.md", "x"),
  );
  assertEquals(message.kind, "document");
  assertEquals(message.kind === "document" ? message.caption : "нет", "");
});

Deno.test("stdin сочетается с -f: текст становится подписью", async () => {
  const message = await logMessage(
    { message: "-", file: "/tmp/a.md" },
    {
      ...ioWithFile("/tmp/a.md", "x"),
      readStdin: () => Promise.resolve(new TextEncoder().encode("из пайпа\n")),
    },
  );
  assertEquals(
    message.kind === "document" ? message.caption : "нет",
    "из пайпа\n",
  );
});

Deno.test("подпись на границе предела: 1024 проходит, 1025 нет", async (t) => {
  const io = ioWithFile("/tmp/a.md", "x");
  await t.step("ровно предел", async () => {
    const caption = "я".repeat(CAPTION_LIMIT);
    const message = await logMessage(
      { message: caption, file: "/tmp/a.md" },
      io,
    );
    assertEquals(
      message.kind === "document" ? message.caption : "нет",
      caption,
    );
  });
  await t.step("предел плюс один символ", async () => {
    const err = await assertRejects(
      () =>
        logMessage(
          { message: "я".repeat(CAPTION_LIMIT + 1), file: "/tmp/a.md" },
          io,
        ),
      VerbatimUsageError,
    );
    // Оба числа в тексте: сколько есть и сколько можно.
    assertEquals(
      err.message,
      "telegram: подпись длиннее предела Bot API: 1025 символов, можно 1024",
    );
    assertEquals(
      `${err.message}\n`,
      await golden("err-caption-long-stderr.txt"),
    );
  });
});

Deno.test("текст сообщения предел подписи не задевает", async () => {
  const text = "я".repeat(CAPTION_LIMIT + 1);
  assertEquals(await logMessage({ message: text }, io("")), {
    kind: "text",
    text,
  });
});

Deno.test("отсутствующий файл — отказ до сети, с путём на экране", async () => {
  const err = await assertRejects(
    () =>
      logMessage(
        { message: "текст", file: "/no/such/file" },
        ioWithFile("/tmp/a.md", "x"),
      ),
    UsageError,
  );
  assertEquals(err.message, "файл-вложение не найден: /no/such/file");
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-file-missing-stderr.txt"),
  );
});

Deno.test("каталог вместо файла — тот же отказ, не падение чтения", async () => {
  // Порт настоящий: «каталог вместо файла» отбивает именно он
  // (`readRegularFile`), и проверять это на фейке нечего.
  const real = makeDenoIo("/nowhere/config.json");
  const dir = await Deno.makeTempDir();
  try {
    const err = await assertRejects(
      () => logMessage({ message: "текст", file: dir }, real),
      UsageError,
    );
    assertEquals(err.message, `файл-вложение не найден: ${dir}`);
  } finally {
    await Deno.remove(dir);
  }
});

Deno.test("повтор -f — ошибка ввода, а не молчаливое схлопывание", async () => {
  const err = await assertRejects(
    () => command.invoke(["текст", "-f", "a.md", "-f", "b.md"], makeFakeIo()),
    UsageError,
  );
  assertEquals(err.message, "option --file may be given only once");
  // Путь в тексте не эхо-печатается: он ушёл бы в секцию err журнала.
  assertEquals(err.message.includes("a.md"), false);
});
