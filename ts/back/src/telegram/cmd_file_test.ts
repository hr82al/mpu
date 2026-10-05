/**
 * `mpu telegram file` по сценариям `docs/specs/telegram-file.md` (TF1):
 * сеанс подменён, каталог файлов — временный вместо `/tmp/mpu-telegram`.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Command } from "../command/mod.ts";
import {
  formatCommandError,
  UsageError,
  VerbatimError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { PeerRef } from "./client.ts";
import {
  type FileSession,
  runTelegramFile,
  telegramFileCommand,
} from "./cmd_file.ts";
import {
  documentFile,
  type MessageFile,
  noFile,
  noMessage,
  photoFile,
} from "./message_file.ts";
import type { ResolvablePeer } from "./peer.ts";

const command: Command = telegramFileCommand;

const CHAT = -1000000000101;

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-file/${name}`, import.meta.url),
  );
}

const encoder = new TextEncoder();

/** Тело вложения F1: 1234 байта, как заявлено. */
const F1_BODY = encoder.encode("#".repeat(1234));

async function* parts(...chunks: readonly Uint8Array[]) {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

/** Обрыв сети после первой части файла (F16, F17). */
async function* brokenAfter(chunk: Uint8Array) {
  yield chunk;
  await Promise.resolve();
  throw new VerbatimError("telegram: RPC error: CONNECTION_LOST");
}

/** Сообщения супергруппы `-1000000000101` по сценариям спеки. */
function messages(): ReadonlyMap<number, MessageFile> {
  return new Map([
    [
      42,
      documentFile(42, {
        name: "разбор.md",
        size: 1234,
        mime: "text/markdown",
      }, () => parts(F1_BODY.slice(0, 1000), F1_BODY.slice(1000))),
    ],
    [43, photoFile(43, 2048, () => parts(new Uint8Array(2048)))],
    [
      44,
      documentFile(44, {
        name: "../../x.md",
        size: 10,
        mime: "text/markdown",
      }, () => parts(encoder.encode("0123456789"))),
    ],
    [45, noFile(45)],
    [47, noFile(47)],
    [
      48,
      documentFile(
        48,
        { name: null, size: 300, mime: "audio/ogg" },
        () => parts(new Uint8Array(300)),
      ),
    ],
  ]);
}

/** Фейк сеанса: чат по id резолвится, прочее — отказ резолва клиента. */
class FakeSession implements FileSession {
  opened = 0;
  closed = 0;
  readonly #files: ReadonlyMap<number, MessageFile>;

  constructor(files: ReadonlyMap<number, MessageFile> = messages()) {
    this.#files = files;
  }

  open(): Promise<FileSession> {
    this.opened++;
    return Promise.resolve(this);
  }

  resolve(peer: ResolvablePeer): Promise<PeerRef> {
    if (peer.kind === "id") return Promise.resolve({ ref: peer, id: peer.id });
    return Promise.reject(
      new VerbatimError("telegram: RPC error: USERNAME_NOT_OCCUPIED"),
    );
  }

  searchChats(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }

  messageFile(_chat: PeerRef, id: number): Promise<MessageFile> {
    return Promise.resolve(this.#files.get(id) ?? noMessage(id));
  }

  close(): Promise<void> {
    this.closed++;
    return Promise.resolve();
  }
}

async function inTempDir(body: (dir: string) => Promise<void>) {
  const root = await Deno.makeTempDir();
  try {
    await body(`${root}/mpu-telegram`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function listing(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  } catch (err) {
    // Каталога нет — в нём ничего не записано.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return names.sort();
}

function file(
  argv: { readonly chat: string; readonly id: string },
  dir: string,
  session: FakeSession = new FakeSession(),
) {
  return runTelegramFile(argv, makeFakeIo({}), {
    openSession: () => session.open(),
    dir,
  });
}

Deno.test("F1: документ — путь, имя, записанный размер, тип", async () => {
  await inTempDir(async (dir) => {
    const session = new FakeSession();
    const saved = await file({ chat: `${CHAT}`, id: "42" }, dir, session);
    assertEquals(saved, {
      path: `${dir}/-1000000000101-42-разбор.md`,
      name: "разбор.md",
      size: 1234,
      mime: "text/markdown",
    });
    assertEquals(await Deno.readFile(saved.path), F1_BODY);
    assertEquals(session.closed, 1);
  });
});

Deno.test("F1: строка вывода совпадает с голденом", async () => {
  const text = command.renderResult({
    path: "/tmp/mpu-telegram/-1000000000101-42-разбор.md",
    name: "разбор.md",
    size: 1234,
    mime: "text/markdown",
  }, ["--chat", `${CHAT}`, "--id", "42"]);
  assertEquals(text, await golden("file-stdout.txt"));
});

Deno.test("F3: повтор — тот же вывод, файл заменён", async () => {
  await inTempDir(async (dir) => {
    const first = await file({ chat: `${CHAT}`, id: "42" }, dir);
    await Deno.writeTextFile(first.path, "испорчено");
    const second = await file({ chat: `${CHAT}`, id: "42" }, dir);
    assertEquals(second, first);
    assertEquals(await Deno.readFile(second.path), F1_BODY);
    assertEquals(await listing(dir), ["-1000000000101-42-разбор.md"]);
  });
});

Deno.test("виды вложения по таблице спеки", async (t) => {
  const cases = [
    {
      name: "F4 фото",
      id: "43",
      saved: {
        file: "-1000000000101-43-photo-43.jpg",
        name: "photo-43.jpg",
        size: 2048,
        mime: "image/jpeg",
      },
    },
    {
      name: "F5 имя ../../x.md",
      id: "44",
      saved: {
        file: "-1000000000101-44-.._.._x.md",
        name: "../../x.md",
        size: 10,
        mime: "text/markdown",
      },
    },
    {
      name: "F9 голосовое без имени",
      id: "48",
      saved: {
        file: "-1000000000101-48-file-48",
        name: "file-48",
        size: 300,
        mime: "audio/ogg",
      },
    },
  ];
  for (const { name, id, saved } of cases) {
    await t.step(name, async () => {
      await inTempDir(async (dir) => {
        const got = await file({ chat: `${CHAT}`, id }, dir);
        assertEquals(got, {
          path: `${dir}/${saved.file}`,
          name: saved.name,
          size: saved.size,
          mime: saved.mime,
        });
        assertEquals((await Deno.stat(got.path)).size, saved.size);
        // Вне каталога ничего: у его родителя — только он сам.
        assertEquals(await listing(`${dir}/..`), ["mpu-telegram"]);
        assertEquals(await listing(dir), [saved.file]);
      });
    });
  }
});

Deno.test("нет файла и нет сообщения — код 1, файла нет", async (t) => {
  const cases = [
    { name: "F6", id: "45", text: "telegram: в сообщении 45 нет файла" },
    { name: "F7", id: "47", text: "telegram: в сообщении 47 нет файла" },
    { name: "F8", id: "46", text: "telegram: сообщение 46 не найдено" },
  ];
  for (const { name, id, text } of cases) {
    await t.step(name, async () => {
      await inTempDir(async (dir) => {
        const err = await assertRejects(
          () => file({ chat: `${CHAT}`, id }, dir),
          VerbatimError,
        );
        assertEquals(err.message, text);
        assertEquals(await listing(dir), []);
      });
    });
  }
});

Deno.test("F6: строка отказа совпадает с голденом", async () => {
  await inTempDir(async (dir) => {
    const err = await assertRejects(
      () => file({ chat: `${CHAT}`, id: "45" }, dir),
      VerbatimError,
    );
    assertEquals(
      `${formatCommandError(command.errorName, err)}\n`,
      await golden("err-no-file-stderr.txt"),
    );
  });
});

Deno.test("F12: id не целое больше 0 — код 2 до сети", async (t) => {
  for (const raw of ["0", "abc", "-5", "1.5", ""]) {
    await t.step(raw, async () => {
      const session = new FakeSession();
      const err = await assertRejects(
        () => file({ chat: "me", id: raw }, "/nonexistent", session),
        UsageError,
      );
      assertEquals(
        formatCommandError(command.errorName, err),
        `mpu telegram file: id — целое больше 0: ${raw}`,
      );
      assertEquals(session.opened, 0);
    });
  }
});

Deno.test("F13: чат не найден — отказ про чат, код 1, файла нет", async () => {
  await inTempDir(async (dir) => {
    const err = await assertRejects(
      () => file({ chat: "@nobody_here", id: "1" }, dir),
      VerbatimError,
    );
    assertStringIncludes(err.message, "не удалось найти чат '@nobody_here'");
    assertEquals(await listing(dir), []);
  });
});

Deno.test("F16: обрыв — по пути нет файла, других файлов вызова нет", async () => {
  await inTempDir(async (dir) => {
    const session = new FakeSession(
      new Map([[
        42,
        documentFile(42, {
          name: "разбор.md",
          size: 1234,
          mime: "text/markdown",
        }, () => brokenAfter(F1_BODY.slice(0, 600))),
      ]]),
    );
    const err = await assertRejects(
      () => file({ chat: `${CHAT}`, id: "42" }, dir, session),
      VerbatimError,
    );
    assertEquals(err.message, "telegram: RPC error: CONNECTION_LOST");
    assertEquals(await listing(dir), []);
    assertEquals(session.closed, 1);
  });
});

Deno.test("F17: обрыв — прежний файл по пути цел", async () => {
  await inTempDir(async (dir) => {
    const first = await file({ chat: `${CHAT}`, id: "42" }, dir);
    const session = new FakeSession(
      new Map([[
        42,
        documentFile(42, {
          name: "разбор.md",
          size: 1234,
          mime: "text/markdown",
        }, () => brokenAfter(new Uint8Array(600))),
      ]]),
    );
    await assertRejects(
      () => file({ chat: `${CHAT}`, id: "42" }, dir, session),
      VerbatimError,
    );
    assertEquals(await Deno.readFile(first.path), F1_BODY);
    assertEquals(await listing(dir), ["-1000000000101-42-разбор.md"]);
  });
});

Deno.test("F14: справка — вопрос, повод звать, путь файла", () => {
  assertEquals(
    command.summary,
    "Скачать вложение сообщения Telegram в локальный файл.",
  );
  const first = command.help.split("\n\n")[0];
  assertStringIncludes(first, "telegram search");
  assertStringIncludes(first, "/tmp/mpu-telegram/<chat_id>-<id>-<имя>");
  for (const part of ["chat:", "id:", "Exit: 0", "1 —", "2 —"]) {
    assertStringIncludes(command.help, part);
  }
  const bytes = encoder.encode(`${command.summary}\n\n${command.help}`).length;
  assertEquals(bytes < 2048, true, `описание не влезло: ${bytes} байт`);
});

Deno.test("F22: справка — картинка агенту блоком, абзац после первого", () => {
  const paragraphs = command.help.split("\n\n");
  const picture = paragraphs[1].replaceAll("\n", " ");
  for (
    const part of [
      "Агенту по MCP картинка",
      "JPEG, PNG, GIF, WebP до 3 750 000 байт",
      "блоком изображения",
      "файл читать не нужно",
      "Прочие вложения — только файлом",
    ]
  ) {
    assertStringIncludes(picture, part);
  }
});

Deno.test("объявление команды: путь, читающая (F15)", () => {
  assertEquals(command.path, ["telegram", "file"]);
  assertEquals(command.policy, "ro");
  assertEquals(command.errorName, "telegram file");
});
