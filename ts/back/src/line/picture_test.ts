/**
 * Картинка результата на уровне строки (`platform/picture-frame.md`,
 * P2, P5–P16, P19, P20): настоящие разбор, доставка, программа и
 * галерея; подменено только исполнение `telegram file` — сеанс Telegram
 * стенда и временный каталог вместо `/tmp/mpu-telegram`.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { IN_PLACE, type Invoker } from "../entrypoint/mod.ts";
import type { PictureData } from "../frames/mod.ts";
import {
  asInbox,
  PICTURE_CHAT,
  savedOnStand,
} from "../telegram/testpicture.ts";
import { LastResults, type Memory, NO_CALLER } from "./it.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { type Ran, runOnStand, unmarked, withStand } from "./testprogram.ts";

/** stdout `telegram file` для сообщения 43 (`S43`). */
const S43 = '{"path": "/tmp/mpu-telegram/-1000000000101-43-photo-43.jpg", ' +
  '"name": "photo-43.jpg", "size": 10, "mime": "image/jpeg"}\n';

const JPEG: PictureData = { mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" };

function file(id: number): string {
  return `telegram file chat: ${PICTURE_CHAT} id: ${id}`;
}

/** Исполнение `telegram file` на стенде, прочее — здесь же. */
function telegramOn(dir: string): Invoker {
  return {
    invoke: (command, args, io, journal) =>
      command.path.join(" ") === "telegram file"
        ? savedOnStand(command.parseArgs(args), io, dir)
        : IN_PLACE.invoke(command, args, io, journal),
  };
}

/** Строка `line` на стенде; файлы — в `dir`. */
type Run = (line: string, memory?: Memory) => Promise<Ran>;

function onStand(body: (run: Run, dir: string) => Promise<void>) {
  return withPolicyFile((policy) =>
    withStand(async (stand) => {
      allowEverything(policy);
      const dir = await Deno.makeTempDir();
      try {
        await body(
          (line, memory = NO_CALLER) =>
            runOnStand(policy, unmarked(line).split(" "), stand, {
              invoker: telegramOn(dir),
              memory,
            }),
          dir,
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    })
  );
}

Deno.test("P1, P2: фото — stdout S43 побайтово, картинка JPEG", () =>
  onStand(async (run, dir) => {
    const ran = await run(file(43));
    assertEquals(
      [ran.exit, asInbox(ran.stdout, dir), ran.stderr],
      [0, S43, ""],
    );
    assertEquals(ran.pictures, [JPEG]);
  }));

Deno.test("вид картинки — по байтам файла (P5–P10)", async (t) => {
  const cases = [
    { id: 50, mimes: ["image/png"], data: "iVBORw0KGgoAAA==" },
    { id: 51, mimes: ["image/gif"], data: "R0lGODlhAQABAA==" },
    { id: 52, mimes: ["image/webp"], data: "UklGRgwAAABXRUJQVlA4IA==" },
    { id: 53, mimes: [], shown: '"mime": "image/svg+xml"' },
    { id: 42, mimes: [] },
    { id: 54, mimes: [], shown: '"mime": "image/png"' },
    {
      id: 55,
      mimes: ["image/jpeg"],
      data: JPEG.data,
      shown: '"mime": "application/octet-stream"',
    },
  ];
  for (const { id, mimes, data, shown } of cases) {
    await t.step(`сообщение ${id}`, () =>
      onStand(async (run) => {
        const ran = await run(file(id));
        assertEquals(ran.exit, 0, ran.stderr);
        assertEquals(ran.pictures.map((one) => one.mime), mimes);
        if (data !== undefined) assertEquals(ran.pictures[0].data, data);
        if (shown !== undefined) assertStringIncludes(ran.stdout, shown);
      }));
  }
});

Deno.test("граница предела на строку (P11, P12)", async (t) => {
  for (const [id, count] of [[56, 1], [57, 0]]) {
    await t.step(`сообщение ${id}`, () =>
      onStand(async (run) => {
        const ran = await run(file(id));
        assertEquals(ran.exit, 0, ran.stderr);
        assertEquals(ran.pictures.length, count);
        if (id === 57) assertStringIncludes(ran.stdout, '"size": 3750001');
      }));
  }
});

Deno.test("сумма по программе: блок у той, что помещается первой (P13, P14)", async (t) => {
  const cases = [
    { name: "P13: 43, затем 56", ids: [43, 56], sizes: [10] },
    { name: "P14: 56, затем 43", ids: [56, 43], sizes: [3_750_000] },
  ];
  for (const { name, ids, sizes } of cases) {
    await t.step(name, () =>
      onStand(async (run, dir) => {
        const ran = await run(ids.map(file).join(" . "));
        assertEquals(ran.exit, 0, ran.stderr);
        assertEquals(
          ran.pictures.map((one) => atob(one.data).length),
          sizes,
        );
        for (const name of ["43-photo-43.jpg", "56-photo-56.jpg"]) {
          await Deno.stat(`${dir}/-1000000000101-${name}`);
        }
      }));
  }
});

Deno.test("P20: программа — картинки в порядке команд", () =>
  onStand(async (run) => {
    const ran = await run(`${file(43)} . ${file(50)}`);
    assertEquals(ran.exit, 0, ran.stderr);
    assertEquals(ran.pictures.map((one) => one.mime), [
      "image/jpeg",
      "image/png",
    ]);
  }));

Deno.test("P15: нет файла — код 1, картинки нет", () =>
  onStand(async (run) => {
    const ran = await run(file(45));
    assertEquals([ran.exit, ran.pictures], [1, []]);
  }));

Deno.test("P19: программа с отказом — картинок нет, файл 43 записан", () =>
  onStand(async (run, dir) => {
    const ran = await run(`${file(43)} . ${file(46)}`);
    assert(ran.exit !== 0);
    assertStringIncludes(ran.stderr, "telegram: сообщение 46 не найдено");
    assertEquals(ran.pictures, []);
    await Deno.stat(`${dir}/-1000000000101-43-photo-43.jpg`);
  }));

Deno.test("P16: it после P1 — тот же JSON, картинки нет", () =>
  onStand(async (run, dir) => {
    const results = new LastResults(() => 0);
    const first = await run(file(43), results.of("ppid:1"));
    assertEquals(first.pictures, [JPEG]);
    const it = await run("it end json", results.of("ppid:1"));
    assertEquals(it.exit, 0, it.stderr);
    assertEquals(
      JSON.parse(asInbox(it.stdout, dir)),
      JSON.parse(S43),
    );
    assertEquals(it.pictures, []);
  }));
