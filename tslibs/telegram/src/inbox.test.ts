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
import { expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { TelegramError } from "./errors.ts";
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
  throw new TelegramError("telegram: RPC error: CONNECTION_LOST");
}

async function listing(dir: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    names.push(entry.name);
  }
  return names.sort();
}

it("keep — файл по пути, size — записанные байты", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const dir = `${root}/inbox`;
    const kept = await new Inbox(dir).keep("a.md", chunks("при", "вет"));
    expect(kept).toStrictEqual({ path: `${dir}/a.md`, size: 12 });
    expect(await readFile(kept.path, "utf8")).toBe("привет");
    expect(await listing(dir)).toStrictEqual(["a.md"]);
    // Каталога не было — создан только владельцу.
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true });
  }
});

it("keep — повтор заменяет файл", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const inbox = new Inbox(dir);
    await inbox.keep("a.md", chunks("старое содержимое"));
    const kept = await inbox.keep("a.md", chunks("новое"));
    expect(await readFile(kept.path, "utf8")).toBe("новое");
    expect(await listing(dir)).toStrictEqual(["a.md"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("keep — обрыв: файла нет, временного тоже (F16)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const err = await rejected(
      () => new Inbox(dir).keep("a.md", broken("половина")),
      TelegramError,
    );
    // Отказ сети уходит как есть, без обёртки «не удалось записать».
    expect(err.message).toBe("telegram: RPC error: CONNECTION_LOST");
    expect(await listing(dir)).toStrictEqual([]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("keep — обрыв: прежний файл цел (F17)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const inbox = new Inbox(dir);
    await inbox.keep("a.md", chunks("целое вложение"));
    await expect(inbox.keep("a.md", broken("обрывок"))).rejects.toThrow();
    expect(await readFile(`${dir}/a.md`, "utf8")).toBe("целое вложение");
    expect(await listing(dir)).toStrictEqual(["a.md"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("keep — каталог не создать: строка слоя с путём", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // На месте каталога — обычный файл: mkdir отказывает.
    await writeFile(`${root}/inbox`, "");
    const err = await rejected(
      () => new Inbox(`${root}/inbox`).keep("a.md", chunks("x")),
      TelegramError,
    );
    expect(
      err.message.startsWith(
        `telegram: не удалось записать ${root}/inbox/a.md: `,
      ),
      err.message,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true });
  }
});
