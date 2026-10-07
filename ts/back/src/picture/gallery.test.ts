/**
 * Галерея строки: картинки результатов по порядку, предел суммы байтов
 * на ответ (`platform/picture-frame.md`, «Предел», P11–P14) и файлы,
 * которых к концу строки нет.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filePicture, Gallery, NO_PICTURE, PICTURE_LIMIT } from "./mod.ts";

const JPEG_HEAD = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46];

/** Файл `size` байт, начинающийся байтами JPEG. */
async function jpeg(dir: string, name: string, size: number): Promise<string> {
  const bytes = new Uint8Array(size);
  bytes.set(JPEG_HEAD.slice(0, size));
  const path = `${dir}/${name}`;
  await writeFile(path, bytes);
  return path;
}

async function inTempDir(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Размеры картинок, которые галерея отдала кадрами. */
async function sizes(gallery: Gallery): Promise<number[]> {
  const frames = await gallery.frames(0);
  return frames.map((frame) => atob(frame.data).length);
}

it("предел — 3 750 000 байт на ответ", () => {
  expect(PICTURE_LIMIT).toBe(3_750_000);
});

it("картинка файла — base64 его байтов (P1)", async () => {
  await inTempDir(async (dir) => {
    const gallery = new Gallery(PICTURE_LIMIT);
    gallery.offer(filePicture(await jpeg(dir, "43.jpg", 10)));
    expect(await gallery.frames(0)).toStrictEqual([
      { mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    ]);
  });
});

describe("граница предела (P11, P12)", () => {
  for (const [size, shown] of [[3_750_000, 1], [3_750_001, 0]]) {
    it(`${size} байт — картинок ${shown}`, async () => {
      await inTempDir(async (dir) => {
        const gallery = new Gallery(PICTURE_LIMIT);
        gallery.offer(filePicture(await jpeg(dir, "photo.jpg", size)));
        expect((await gallery.frames(0)).length).toStrictEqual(shown);
      });
    });
  }
});

describe("сумма по ответу: не поместившаяся предел не расходует (P13, P14)", () => {
  const cases = [
    { name: "P13: 10, затем 3 750 000", order: [10, 3_750_000], kept: [10] },
    {
      name: "P14: 3 750 000, затем 10",
      order: [3_750_000, 10],
      kept: [3_750_000],
    },
    {
      name: "за пределом пропущена, следующая помещается",
      order: [3_750_001, 10, 20],
      kept: [10, 20],
    },
  ];
  for (const { name, order, kept } of cases) {
    it(name, async () => {
      await inTempDir(async (dir) => {
        const gallery = new Gallery(PICTURE_LIMIT);
        for (const [at, size] of order.entries()) {
          gallery.offer(filePicture(await jpeg(dir, `${at}.jpg`, size)));
        }
        expect(await sizes(gallery)).toStrictEqual(kept);
      });
    });
  }
});

it("не картинка предел не расходует", async () => {
  await inTempDir(async (dir) => {
    const text = `${dir}/a.md`;
    await writeFile(text, "#".repeat(3_000_000));
    const gallery = new Gallery(PICTURE_LIMIT);
    gallery.offer(filePicture(text));
    gallery.offer(filePicture(await jpeg(dir, "b.jpg", 3_000_000)));
    expect(await sizes(gallery)).toStrictEqual([3_000_000]);
  });
});

it("порядок картинок — порядок результатов", async () => {
  await inTempDir(async (dir) => {
    const png = `${dir}/b.png`;
    await writeFile(
      png,
      new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]),
    );
    const gallery = new Gallery(PICTURE_LIMIT);
    gallery.offer(filePicture(await jpeg(dir, "a.jpg", 10)));
    gallery.offer(NO_PICTURE);
    gallery.offer(filePicture(png));
    expect((await gallery.frames(0)).map((frame) => frame.mime)).toStrictEqual([
      "image/jpeg",
      "image/png",
    ]);
  });
});

it("строка с кодом ≠ 0 — картинок нет, файлы не читаются (P19)", async () => {
  await inTempDir(async (dir) => {
    const gallery = new Gallery(PICTURE_LIMIT);
    let read = 0;
    gallery.offer({ addTo: () => Promise.resolve(void read++) });
    gallery.offer(filePicture(await jpeg(dir, "a.jpg", 10)));
    expect(await gallery.frames(1)).toStrictEqual([]);
    expect(read).toBe(0);
  });
});

describe("не прочитать — картинки нет, отказа нет", () => {
  it("нет прав", () =>
    inTempDir(async (dir) => {
      const locked = await jpeg(dir, "locked.jpg", 10);
      await chmod(locked, 0o000);
      const gallery = new Gallery(PICTURE_LIMIT);
      gallery.offer(filePicture(locked));
      expect(await gallery.frames(0)).toStrictEqual([]);
    }));
  it("не файл, а каталог", () =>
    inTempDir(async (dir) => {
      const gallery = new Gallery(PICTURE_LIMIT);
      gallery.offer(filePicture(dir));
      expect(await gallery.frames(0)).toStrictEqual([]);
    }));
});

it("предел — по прочитанным байтам, а не по размеру до чтения", async () => {
  const gallery = new Gallery(10);
  gallery.take("image/jpeg", new Uint8Array(11));
  gallery.take("image/png", new Uint8Array(10));
  expect((await gallery.frames(0)).map((one) => one.mime)).toStrictEqual([
    "image/png",
  ]);
});

it("файла к концу строки нет — картинки нет, отказа нет", async () => {
  await inTempDir(async (dir) => {
    const gallery = new Gallery(PICTURE_LIMIT);
    const gone = await jpeg(dir, "gone.jpg", 10);
    gallery.offer(filePicture(gone));
    await rm(gone);
    gallery.offer(filePicture(await jpeg(dir, "kept.jpg", 10)));
    expect(await gallery.frames(0)).toStrictEqual([
      { mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    ]);
  });
});
