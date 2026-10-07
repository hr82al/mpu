/**
 * `mpu telegram file` по сценариям `docs/specs/telegram-file.md` (TF1):
 * сеанс подменён, каталог файлов — временный вместо `/tmp/mpu-telegram`.
 */

import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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
  return await readFile(
    new URL(`./testdata/telegram-file/${name}`, import.meta.url),
    "utf8",
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
      documentFile(
        42,
        {
          name: "разбор.md",
          size: 1234,
          mime: "text/markdown",
        },
        () => parts(F1_BODY.slice(0, 1000), F1_BODY.slice(1000)),
      ),
    ],
    [43, photoFile(43, 2048, () => parts(new Uint8Array(2048)))],
    [
      44,
      documentFile(
        44,
        {
          name: "../../x.md",
          size: 10,
          mime: "text/markdown",
        },
        () => parts(encoder.encode("0123456789")),
      ),
    ],
    [45, noFile(45)],
    [47, noFile(47)],
    [
      48,
      documentFile(48, { name: null, size: 300, mime: "audio/ogg" }, () =>
        parts(new Uint8Array(300)),
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
  const root = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await body(`${root}/mpu-telegram`);
  } finally {
    await rm(root, { recursive: true });
  }
}

async function listing(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      names.push(entry.name);
    }
  } catch (err) {
    // Каталога нет — в нём ничего не записано.
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      throw err;
    }
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

it("F1: документ — путь, имя, записанный размер, тип", async () => {
  await inTempDir(async (dir) => {
    const session = new FakeSession();
    const saved = await file({ chat: `${CHAT}`, id: "42" }, dir, session);
    expect(saved).toStrictEqual({
      path: `${dir}/-1000000000101-42-разбор.md`,
      name: "разбор.md",
      size: 1234,
      mime: "text/markdown",
    });
    expect(new Uint8Array(await readFile(saved.path))).toStrictEqual(F1_BODY);
    expect(session.closed).toBe(1);
  });
});

it("F1: строка вывода совпадает с голденом", async () => {
  const text = command.renderResult(
    {
      path: "/tmp/mpu-telegram/-1000000000101-42-разбор.md",
      name: "разбор.md",
      size: 1234,
      mime: "text/markdown",
    },
    ["--chat", `${CHAT}`, "--id", "42"],
  );
  expect(text).toStrictEqual(await golden("file-stdout.txt"));
});

it("F3: повтор — тот же вывод, файл заменён", async () => {
  await inTempDir(async (dir) => {
    const first = await file({ chat: `${CHAT}`, id: "42" }, dir);
    await writeFile(first.path, "испорчено");
    const second = await file({ chat: `${CHAT}`, id: "42" }, dir);
    expect(second).toStrictEqual(first);
    expect(new Uint8Array(await readFile(second.path))).toStrictEqual(F1_BODY);
    expect(await listing(dir)).toStrictEqual(["-1000000000101-42-разбор.md"]);
  });
});

describe("виды вложения по таблице спеки", () => {
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
    it(name, async () => {
      await inTempDir(async (dir) => {
        const got = await file({ chat: `${CHAT}`, id }, dir);
        expect(got).toStrictEqual({
          path: `${dir}/${saved.file}`,
          name: saved.name,
          size: saved.size,
          mime: saved.mime,
        });
        expect((await stat(got.path)).size).toStrictEqual(saved.size);
        // Вне каталога ничего: у его родителя — только он сам.
        expect(await listing(`${dir}/..`)).toStrictEqual(["mpu-telegram"]);
        expect(await listing(dir)).toStrictEqual([saved.file]);
      });
    });
  }
});

describe("нет файла и нет сообщения — код 1, файла нет", () => {
  const cases = [
    { name: "F6", id: "45", text: "telegram: в сообщении 45 нет файла" },
    { name: "F7", id: "47", text: "telegram: в сообщении 47 нет файла" },
    { name: "F8", id: "46", text: "telegram: сообщение 46 не найдено" },
  ];
  for (const { name, id, text } of cases) {
    it(name, async () => {
      await inTempDir(async (dir) => {
        const err = await rejected(
          () => file({ chat: `${CHAT}`, id }, dir),
          VerbatimError,
        );
        expect(err.message).toStrictEqual(text);
        expect(await listing(dir)).toStrictEqual([]);
      });
    });
  }
});

it("F6: строка отказа совпадает с голденом", async () => {
  await inTempDir(async (dir) => {
    const err = await rejected(
      () => file({ chat: `${CHAT}`, id: "45" }, dir),
      VerbatimError,
    );
    expect(`${formatCommandError(command.errorName, err)}\n`).toStrictEqual(
      await golden("err-no-file-stderr.txt"),
    );
  });
});

describe("F12: id не целое больше 0 — код 2 до сети", () => {
  for (const raw of ["0", "abc", "-5", "1.5", ""]) {
    it(raw, async () => {
      const session = new FakeSession();
      const err = await rejected(
        () => file({ chat: "me", id: raw }, "/nonexistent", session),
        UsageError,
      );
      expect(formatCommandError(command.errorName, err)).toStrictEqual(
        `mpu telegram file: id — целое больше 0: ${raw}`,
      );
      expect(session.opened).toBe(0);
    });
  }
});

it("F13: чат не найден — отказ про чат, код 1, файла нет", async () => {
  await inTempDir(async (dir) => {
    const err = await rejected(
      () => file({ chat: "@nobody_here", id: "1" }, dir),
      VerbatimError,
    );
    expect(err.message).toContain("не удалось найти чат '@nobody_here'");
    expect(await listing(dir)).toStrictEqual([]);
  });
});

it("F16: обрыв — по пути нет файла, других файлов вызова нет", async () => {
  await inTempDir(async (dir) => {
    const session = new FakeSession(
      new Map([
        [
          42,
          documentFile(
            42,
            {
              name: "разбор.md",
              size: 1234,
              mime: "text/markdown",
            },
            () => brokenAfter(F1_BODY.slice(0, 600)),
          ),
        ],
      ]),
    );
    const err = await rejected(
      () => file({ chat: `${CHAT}`, id: "42" }, dir, session),
      VerbatimError,
    );
    expect(err.message).toBe("telegram: RPC error: CONNECTION_LOST");
    expect(await listing(dir)).toStrictEqual([]);
    expect(session.closed).toBe(1);
  });
});

it("F17: обрыв — прежний файл по пути цел", async () => {
  await inTempDir(async (dir) => {
    const first = await file({ chat: `${CHAT}`, id: "42" }, dir);
    const session = new FakeSession(
      new Map([
        [
          42,
          documentFile(
            42,
            {
              name: "разбор.md",
              size: 1234,
              mime: "text/markdown",
            },
            () => brokenAfter(new Uint8Array(600)),
          ),
        ],
      ]),
    );
    await expect(
      file({ chat: `${CHAT}`, id: "42" }, dir, session),
    ).rejects.toThrow(VerbatimError);
    expect(new Uint8Array(await readFile(first.path))).toStrictEqual(F1_BODY);
    expect(await listing(dir)).toStrictEqual(["-1000000000101-42-разбор.md"]);
  });
});

it("F14: справка — вопрос, повод звать, путь файла", () => {
  expect(command.summary).toBe(
    "Скачать вложение сообщения Telegram в локальный файл.",
  );
  const first = command.help.split("\n\n")[0];
  expect(first).toContain("telegram search");
  expect(first).toContain("/tmp/mpu-telegram/<chat_id>-<id>-<имя>");
  for (const part of ["chat:", "id:", "Exit: 0", "1 —", "2 —"]) {
    expect(command.help).toContain(part);
  }
  const bytes = encoder.encode(`${command.summary}\n\n${command.help}`).length;
  expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
});

it("F22: справка — картинка агенту блоком, абзац после первого", () => {
  const paragraphs = command.help.split("\n\n");
  const picture = paragraphs[1].replaceAll("\n", " ");
  for (const part of [
    "Агенту по MCP картинка",
    "JPEG, PNG, GIF, WebP до 3 750 000 байт",
    "блоком изображения",
    "файл читать не нужно",
    "Прочие вложения — только файлом",
  ]) {
    expect(picture).toContain(part);
  }
});

it("объявление команды: путь, читающая (F15)", () => {
  expect(command.path).toStrictEqual(["telegram", "file"]);
  expect(command.policy).toBe("ro");
  expect(command.errorName).toBe("telegram file");
});
