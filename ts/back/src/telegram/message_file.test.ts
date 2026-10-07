import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { VerbatimError } from "../command/mod.ts";
import { Inbox } from "./inbox.ts";
import {
  documentFile,
  type FileBytes,
  noFile,
  noMessage,
  photoFile,
} from "./message_file.ts";

const CHAT = -1000000000101;

function bytesOf(text: string): FileBytes {
  return async function* () {
    await Promise.resolve();
    yield new TextEncoder().encode(text);
  };
}

async function listing(dir: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    names.push(entry.name);
  }
  return names.sort();
}

describe("описание вложения по таблице спеки", () => {
  const none = bytesOf("");
  const cases = [
    {
      name: "документ с именем",
      file: documentFile(42, {
        name: "разбор.md",
        size: 1234,
        mime: "text/markdown",
      }, none),
      listed: { name: "разбор.md", size: 1234, mime: "text/markdown" },
    },
    {
      name: "документ с пустым типом",
      file: documentFile(49, { name: "a.bin", size: 5, mime: "" }, none),
      listed: { name: "a.bin", size: 5, mime: null },
    },
    {
      name: "документ без имени (F9)",
      file: documentFile(
        48,
        { name: null, size: 300, mime: "audio/ogg" },
        none,
      ),
      listed: { name: "file-48", size: 300, mime: "audio/ogg" },
    },
    {
      name: "документ с пустым именем — как без имени",
      file: documentFile(51, { name: "", size: 1, mime: "text/plain" }, none),
      listed: { name: "file-51", size: 1, mime: "text/plain" },
    },
    {
      name: "фото (F4)",
      file: photoFile(43, 2048, none),
      listed: { name: "photo-43.jpg", size: 2048, mime: "image/jpeg" },
    },
    { name: "нет файла", file: noFile(45), listed: null },
  ];
  for (const { name, file, listed } of cases) {
    it(name, () => expect(file.listed()).toStrictEqual(listed));
  }
});

it("saveTo — путь <chat>-<id>-<имя>, size из записи", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Заявка Telegram (1234) расходится с записанным: в вывод идёт записанное.
    const file = documentFile(42, {
      name: "разбор.md",
      size: 1234,
      mime: "text/markdown",
    }, bytesOf("# разбор"));
    const saved = await file.saveTo(new Inbox(dir), CHAT);
    expect(saved).toStrictEqual({
      path: `${dir}/-1000000000101-42-разбор.md`,
      name: "разбор.md",
      size: 14,
      mime: "text/markdown",
    });
    expect((await stat(saved.path)).size).toStrictEqual(saved.size);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("saveTo — имя с ../ и NUL не уводит из каталога (F5)", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const dir = `${root}/a/b`;
    const file = documentFile(44, {
      name: "../../x\0.md",
      size: 10,
      mime: "text/markdown",
    }, bytesOf("0123456789"));
    const saved = await file.saveTo(new Inbox(dir), CHAT);
    expect(saved.path).toStrictEqual(`${dir}/-1000000000101-44-.._.._x_.md`);
    expect(saved.name).toBe("../../x\0.md");
    // Вне каталога ничего: у предков — только путь к нему.
    expect(await listing(root)).toStrictEqual(["a"]);
    expect(await listing(`${root}/a`)).toStrictEqual(["b"]);
    expect(await listing(dir)).toStrictEqual(["-1000000000101-44-.._.._x_.md"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

describe("нет файла и нет сообщения — отказ слоя, каталог не тронут", () => {
  const cases = [
    { file: noFile(45), text: "telegram: в сообщении 45 нет файла" },
    { file: noMessage(46), text: "telegram: сообщение 46 не найдено" },
  ];
  for (const { file, text } of cases) {
    it(text, async () => {
      const root = await mkdtemp(join(tmpdir(), "mpu-"));
      try {
        const err = await file.saveTo(new Inbox(`${root}/inbox`), CHAT).then(
          () => null,
          (e: unknown) => e,
        );
        assert(err instanceof VerbatimError, "ожидался отказ VerbatimError");
        expect(err.message).toStrictEqual(text);
        expect(await listing(root)).toStrictEqual([]);
      } finally {
        await rm(root, { recursive: true });
      }
    });
  }
});

describe("длинное имя на диске — не длиннее 255 байт (F23–F33)", () => {
  const a = "а"; // кириллица, 2 байта
  const cases = [
    { id: 60, name: `${a.repeat(117)}.md`, disk: `${a.repeat(117)}.md` },
    { id: 61, name: `${a.repeat(118)}.md`, disk: `${a.repeat(117)}.md` },
    { id: 62, name: "a".repeat(237), disk: "a".repeat(237) },
    { id: 63, name: "a".repeat(238), disk: "a".repeat(237) },
    { id: 64, name: a.repeat(200), disk: a.repeat(118) },
    { id: 65, name: `${"😀".repeat(60)}.png`, disk: `${"😀".repeat(58)}.png` },
    { id: 66, name: `x.${"y".repeat(300)}`, disk: `x.${"y".repeat(235)}` },
    { id: 67, name: `.${"b".repeat(300)}`, disk: `.${"b".repeat(236)}` },
    {
      id: 68,
      name: `../${a.repeat(118)}.md`,
      disk: `.._${a.repeat(115)}.md`,
    },
    {
      id: 69,
      name: `отчёт.v2.final.${"я".repeat(120)}.xlsx`,
      disk: `отчёт.v2.final.${"я".repeat(106)}.xlsx`,
    },
    { id: 42, name: "разбор.md", disk: "разбор.md" },
  ];
  // Один ящик на все шаги, как и до перевода: имена файлов у шагов разные.
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mpu-"));
  });
  afterAll(() => rm(root, { recursive: true }));
  for (const { id, name, disk } of cases) {
    it(`${id}: ${name.slice(0, 12)}…`, async () => {
      const file = documentFile(id, {
        name,
        size: 10,
        mime: "text/markdown",
      }, bytesOf("0123456789"));
      const saved = await file.saveTo(new Inbox(root), CHAT);
      expect(saved.path).toStrictEqual(`${root}/-1000000000101-${id}-${disk}`);
      expect(saved.name).toStrictEqual(name);
      expect((await stat(saved.path)).size).toBe(10);
    });
  }
});
