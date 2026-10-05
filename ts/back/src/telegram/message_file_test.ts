import { assertEquals, assertRejects } from "@std/assert";
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
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("описание вложения по таблице спеки", async (t) => {
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
    await t.step(name, () => assertEquals(file.listed(), listed));
  }
});

Deno.test("saveTo — путь <chat>-<id>-<имя>, size из записи", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Заявка Telegram (1234) расходится с записанным: в вывод идёт записанное.
    const file = documentFile(42, {
      name: "разбор.md",
      size: 1234,
      mime: "text/markdown",
    }, bytesOf("# разбор"));
    const saved = await file.saveTo(new Inbox(dir), CHAT);
    assertEquals(saved, {
      path: `${dir}/-1000000000101-42-разбор.md`,
      name: "разбор.md",
      size: 14,
      mime: "text/markdown",
    });
    assertEquals((await Deno.stat(saved.path)).size, saved.size);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("saveTo — имя с ../ и NUL не уводит из каталога (F5)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/a/b`;
    const file = documentFile(44, {
      name: "../../x\0.md",
      size: 10,
      mime: "text/markdown",
    }, bytesOf("0123456789"));
    const saved = await file.saveTo(new Inbox(dir), CHAT);
    assertEquals(saved.path, `${dir}/-1000000000101-44-.._.._x_.md`);
    assertEquals(saved.name, "../../x\0.md");
    // Вне каталога ничего: у предков — только путь к нему.
    assertEquals(await listing(root), ["a"]);
    assertEquals(await listing(`${root}/a`), ["b"]);
    assertEquals(await listing(dir), ["-1000000000101-44-.._.._x_.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("нет файла и нет сообщения — отказ слоя, каталог не тронут", async (t) => {
  const cases = [
    { file: noFile(45), text: "telegram: в сообщении 45 нет файла" },
    { file: noMessage(46), text: "telegram: сообщение 46 не найдено" },
  ];
  for (const { file, text } of cases) {
    await t.step(text, async () => {
      const root = await Deno.makeTempDir();
      try {
        const err = await assertRejects(
          () => file.saveTo(new Inbox(`${root}/inbox`), CHAT),
          VerbatimError,
        );
        assertEquals(err.message, text);
        assertEquals(await listing(root), []);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
});
