import { assertEquals, assertRejects } from "@std/assert";
import { VerbatimError } from "../command/mod.ts";
import { Inbox } from "./inbox.ts";

const encoder = new TextEncoder();

async function* chunks(...parts: readonly string[]) {
  for (const part of parts) {
    await Promise.resolve();
    yield encoder.encode(part);
  }
}

/** Поток, обрывающийся после первой части — обрыв сети посреди файла. */
async function* broken(first: string) {
  yield encoder.encode(first);
  await Promise.resolve();
  throw new VerbatimError("telegram: RPC error: CONNECTION_LOST");
}

async function listing(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("keep — файл по пути, size — записанные байты", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/inbox`;
    const kept = await new Inbox(dir).keep("a.md", chunks("при", "вет"));
    assertEquals(kept, { path: `${dir}/a.md`, size: 12 });
    assertEquals(await Deno.readTextFile(kept.path), "привет");
    assertEquals(await listing(dir), ["a.md"]);
    // Каталога не было — создан только владельцу.
    assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("keep — повтор заменяет файл", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const inbox = new Inbox(dir);
    await inbox.keep("a.md", chunks("старое содержимое"));
    const kept = await inbox.keep("a.md", chunks("новое"));
    assertEquals(await Deno.readTextFile(kept.path), "новое");
    assertEquals(await listing(dir), ["a.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("keep — обрыв: файла нет, временного тоже (F16)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const err = await assertRejects(
      () => new Inbox(dir).keep("a.md", broken("половина")),
      VerbatimError,
    );
    // Отказ сети уходит как есть, без обёртки «не удалось записать».
    assertEquals(err.message, "telegram: RPC error: CONNECTION_LOST");
    assertEquals(await listing(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("keep — обрыв: прежний файл цел (F17)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const inbox = new Inbox(dir);
    await inbox.keep("a.md", chunks("целое вложение"));
    await assertRejects(() => inbox.keep("a.md", broken("обрывок")));
    assertEquals(await Deno.readTextFile(`${dir}/a.md`), "целое вложение");
    assertEquals(await listing(dir), ["a.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("keep — каталог не создать: строка слоя с путём", async () => {
  const root = await Deno.makeTempDir();
  try {
    // На месте каталога — обычный файл: mkdir отказывает.
    await Deno.writeTextFile(`${root}/inbox`, "");
    const err = await assertRejects(
      () => new Inbox(`${root}/inbox`).keep("a.md", chunks("x")),
      VerbatimError,
    );
    assertEquals(
      err.message.startsWith(
        `telegram: не удалось записать ${root}/inbox/a.md: `,
      ),
      true,
      err.message,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
