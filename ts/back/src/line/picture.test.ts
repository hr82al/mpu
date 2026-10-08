/**
 * Картинка результата на уровне строки (`platform/picture-frame.md`,
 * P2, P5–P12, P15, P16): настоящие разбор, доставка и галерея;
 * подменено только исполнение `telegram file` — сеанс Telegram стенда и
 * временный каталог вместо `/tmp/mpu-telegram`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IN_PLACE, type Invoker } from "../entrypoint/mod.ts";
import type { PictureData } from "@mpu/language/frames";
import { asInbox, PICTURE_CHAT, savedOnStand } from "@mpu/cmd-telegram/testing";
import { LastResults, type Memory, NO_CALLER } from "./it.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { type Ran, runOnStand, unmarked, withStand } from "./testline.ts";

/** stdout `telegram file` для сообщения 43 (`S43`). */
const S43 =
  '{"path": "/tmp/mpu-telegram/-1000000000101-43-photo-43.jpg", ' +
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
      const dir = await mkdtemp(join(tmpdir(), "mpu-"));
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
        await rm(dir, { recursive: true });
      }
    }),
  );
}

it("P1, P2: фото — stdout S43 побайтово, картинка JPEG", () =>
  onStand(async (run, dir) => {
    const ran = await run(file(43));
    expect([ran.exit, asInbox(ran.stdout, dir), ran.stderr]).toStrictEqual([
      0,
      S43,
      "",
    ]);
    expect(ran.pictures).toStrictEqual([JPEG]);
  }));

describe("вид картинки — по байтам файла (P5–P10)", () => {
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
    it(`сообщение ${id}`, () =>
      onStand(async (run) => {
        const ran = await run(file(id));
        expect(ran.exit, ran.stderr).toBe(0);
        expect(ran.pictures.map((one) => one.mime)).toStrictEqual(mimes);
        if (data !== undefined) {
          expect(ran.pictures[0].data).toStrictEqual(data);
        }
        if (shown !== undefined) expect(ran.stdout).toContain(shown);
      }));
  }
});

describe("граница предела на строку (P11, P12)", () => {
  for (const [id, count] of [
    [56, 1],
    [57, 0],
  ]) {
    it(`сообщение ${id}`, () =>
      onStand(async (run) => {
        const ran = await run(file(id));
        expect(ran.exit, ran.stderr).toBe(0);
        expect(ran.pictures.length).toStrictEqual(count);
        if (id === 57) expect(ran.stdout).toContain('"size": 3750001');
      }));
  }
});

it("P15: нет файла — код 1, картинки нет", () =>
  onStand(async (run) => {
    const ran = await run(file(45));
    expect([ran.exit, ran.pictures]).toStrictEqual([1, []]);
  }));

it("P16: it после P1 — тот же JSON, картинки нет", () =>
  onStand(async (run, dir) => {
    const results = new LastResults(() => 0);
    const first = await run(file(43), results.of("ppid:1"));
    expect(first.pictures).toStrictEqual([JPEG]);
    const it = await run("it end json", results.of("ppid:1"));
    expect(it.exit, it.stderr).toBe(0);
    expect(JSON.parse(asInbox(it.stdout, dir))).toStrictEqual(JSON.parse(S43));
    expect(it.pictures).toStrictEqual([]);
  }));
