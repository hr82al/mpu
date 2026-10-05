/**
 * Картинка в ответе строки через настоящий сервер
 * (`platform/picture-frame.md`, P3, P4, P17, P19, P20): кадр `picture`
 * перед `exit` в потоке, поле `pictures` собранного ответа, журнал без
 * base64. Подменено только исполнение `telegram file` (`testpicture.ts`).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { asInbox, PICTURE_CHAT } from "../telegram/testpicture.ts";
import { PictureLauncher } from "./testpicture.ts";
import { post, type TestBack, withBack } from "./testback.ts";
import { violations } from "./testschema.ts";
import SCHEMA from "./schema.json" with { type: "json" };

const JPEG_DATA = "/9j/4AAQSkZJRg==";

function file(id: number): string[] {
  return ["telegram", "file", "chat:", PICTURE_CHAT, "id:", `${id}`];
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/picture-frame/${name}`, import.meta.url),
  );
}

/** Сервер со стендом картинок; файлы — во временном каталоге `dir`. */
async function withPictures(
  body: (back: TestBack, dir: string) => Promise<void>,
  pictureLimit?: number,
) {
  const dir = await Deno.makeTempDir();
  try {
    await withBack(
      (back) => body(back, dir),
      { launcher: (io) => new PictureLauncher(io, dir), pictureLimit },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Тело ответа строки двери агента как текст спеки. */
async function agentLine(
  back: TestBack,
  dir: string,
  words: readonly string[],
  accept: string,
): Promise<string> {
  const response = await post(
    back,
    "/agent/line",
    { words, cwd: Deno.cwd(), human: false },
    { agent: true, accept },
  );
  const text = await response.text();
  back.seen.push(text);
  return asInbox(text, dir);
}

const NDJSON = "application/x-ndjson";
const JSON_TYPE = "application/json";

/** Строка программы из команд `telegram file` по сообщениям `ids`. */
function program(...ids: number[]): string[] {
  return ids.flatMap((id, at) => at === 0 ? file(id) : [".", ...file(id)]);
}

Deno.test("P4: поток — out, picture, exit; голден", () =>
  withPictures(async (back, dir) => {
    const text = await agentLine(back, dir, file(43), NDJSON);
    assertEquals(text, await golden("ndjson-p4.txt"));
  }));

Deno.test("P3: собранный ответ — поле pictures после exit; голден", () =>
  withPictures(async (back, dir) => {
    const text = await agentLine(back, dir, file(43), JSON_TYPE);
    assertEquals(`${text}\n`, await golden("collected-p3.json"));
  }));

Deno.test("P20: картинки программы — все после вывода, перед exit", () =>
  withPictures(async (back, dir) => {
    const text = await agentLine(back, dir, program(43, 50), NDJSON);
    const kinds = text.trimEnd().split("\n").map((row) =>
      Object.keys(JSON.parse(row))[0]
    );
    // Программа печатает результат последнего оператора; картинку даёт
    // каждый успешный результат ([D.5]).
    assertEquals(kinds, ["out", "picture", "picture", "exit"]);
    const pictures = text.trimEnd().split("\n").map((row) => JSON.parse(row))
      .filter((frame) => "picture" in frame).map((frame) => frame.picture);
    assertEquals(pictures.map((one) => one.mime), ["image/jpeg", "image/png"]);
    assertEquals(JSON.parse(text.trimEnd().split("\n").at(-1) ?? ""), {
      exit: 0,
    });
  }));

Deno.test("P19: строка с отказом — ни кадра, ни поля картинки", () =>
  withPictures(async (back, dir) => {
    const stream = await agentLine(back, dir, program(43, 46), NDJSON);
    assert(!stream.includes('"picture"'), stream);
    const whole = JSON.parse(
      await agentLine(back, dir, program(43, 46), JSON_TYPE),
    );
    assert(whole.exit !== 0);
    assertEquals("pictures" in whole, false);
    await Deno.stat(`${dir}/-1000000000101-43-photo-43.jpg`);
  }));

Deno.test("P8: строка без картинок — поля pictures нет", () =>
  withPictures(async (back, dir) => {
    const whole = JSON.parse(await agentLine(back, dir, file(42), JSON_TYPE));
    assertEquals(whole.exit, 0);
    assertEquals("pictures" in whole, false);
  }));

Deno.test("P17: журнал — вывод S43, base64 картинки нет", () =>
  withPictures(async (back, dir) => {
    await agentLine(back, dir, file(43), JSON_TYPE);
    const logged = asInbox(back.logged.join(""), dir);
    assertStringIncludes(logged, '"name": "photo-43.jpg", "size": 10');
    assertEquals(logged.includes(JPEG_DATA), false);
  }));

Deno.test("кадры P4 и собранный P3 — по схеме кадров", async () => {
  const frames = (await golden("ndjson-p4.txt")).trimEnd().split("\n");
  for (const row of frames) {
    const node = SCHEMA.$defs["line.server"];
    assertEquals(violations(SCHEMA, node, JSON.parse(row)), [], row);
  }
  // Корень собранного ответа держит слова вне подмножества сверки
  // (`anyOf`, `not`) — сверяется его поле.
  const { pictures } = JSON.parse(await golden("collected-p3.json"));
  const field = SCHEMA.$defs["http.line.collected"].properties.pictures;
  assertEquals(violations(SCHEMA, field, pictures), []);
  // Сверка не слепа: чужой вид картинки — нарушение.
  const spoiled = [{ mime: "image/svg+xml", data: "" }];
  assert(violations(SCHEMA, field, spoiled).length > 0);
});

Deno.test("предел — параметр сервера: 9 байт не вмещают фото 43", () =>
  withPictures(async (back, dir) => {
    const whole = JSON.parse(await agentLine(back, dir, file(43), JSON_TYPE));
    assertEquals(whole.exit, 0);
    assertEquals("pictures" in whole, false);
  }, 9));
