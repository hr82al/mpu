/**
 * Картинка в ответе тула (`platform/picture-frame.md`, P1, P7, P9, P16,
 * P19): настоящие `back`, переводчик и клиент SDK; подменено только
 * исполнение `telegram file` — сеанс Telegram стенда и временный каталог.
 */

import { assertEquals } from "@std/assert";
import { PictureLauncher } from "../../back/src/backend/testpicture.ts";
import { asInbox, PICTURE_CHAT } from "../../back/src/telegram/testpicture.ts";
import { call, type Stack, withClient, withStack } from "./testkit.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

function file(id: number): string[] {
  return ["telegram", "file", "chat:", PICTURE_CHAT, "id:", `${id}`];
}

/** Стек со стендом картинок; файлы — во временном каталоге `dir`. */
async function withPictures(
  body: (stack: Stack, client: Client, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    await withStack(
      (stack) => withClient(stack, (client) => body(stack, client, dir)),
      { launcher: (io) => new PictureLauncher(io, dir) },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Ответ тула `mpu` как текст спеки. */
async function tool(
  stack: Stack,
  client: Client,
  dir: string,
  words: readonly string[],
): Promise<Record<string, unknown>> {
  const result = await call(stack, client, "mpu", { words });
  return JSON.parse(asInbox(JSON.stringify(result), dir));
}

function blocks(result: Record<string, unknown>): string[] {
  const content = result.content as readonly { readonly type: string }[];
  return content.map((one) => one.type);
}

Deno.test("P1: текст S43 и блок image; structuredContent без картинки", () =>
  withPictures(async (stack, client, dir) => {
    const result = await tool(stack, client, dir, file(43));
    const golden = await Deno.readTextFile(
      new URL("./testdata/picture-frame/tool-result-p1.json", import.meta.url),
    );
    assertEquals(result, JSON.parse(golden));
  }));

Deno.test("не картинка — только текст, без ошибки (P7, P9)", async (t) => {
  for (const id of [53, 54]) {
    await t.step(
      `сообщение ${id}`,
      () =>
        withPictures(async (stack, client, dir) => {
          const result = await tool(stack, client, dir, file(id));
          assertEquals([blocks(result), result.isError], [["text"], false]);
        }),
    );
  }
});

Deno.test("P16: it end json после P1 — JSON без блока image", () =>
  withPictures(async (stack, client, dir) => {
    await tool(stack, client, dir, file(43));
    const it = await tool(stack, client, dir, ["it", "end", "json"]);
    assertEquals([blocks(it), it.isError], [["text"], false]);
    const structured = it.structuredContent as { readonly stdout: string };
    assertEquals(JSON.parse(structured.stdout), {
      path: "/tmp/mpu-telegram/-1000000000101-43-photo-43.jpg",
      name: "photo-43.jpg",
      size: 10,
      mime: "image/jpeg",
    });
  }));

Deno.test("P19: программа с отказом — isError, блоков image нет", () =>
  withPictures(async (stack, client, dir) => {
    const result = await tool(stack, client, dir, [
      ...file(43),
      ".",
      ...file(46),
    ]);
    assertEquals(result.isError, true);
    assertEquals(blocks(result).includes("image"), false);
  }));
