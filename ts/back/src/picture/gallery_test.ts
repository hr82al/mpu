/**
 * Галерея строки: картинки результатов по порядку, предел суммы байтов
 * на ответ (`platform/picture-frame.md`, «Предел», P11–P14) и файлы,
 * которых к концу строки нет.
 */

import { assertEquals } from "@std/assert";
import { filePicture, Gallery, NO_PICTURE, PICTURE_LIMIT } from "./mod.ts";

const JPEG_HEAD = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46];

/** Файл `size` байт, начинающийся байтами JPEG. */
async function jpeg(dir: string, name: string, size: number): Promise<string> {
  const bytes = new Uint8Array(size);
  bytes.set(JPEG_HEAD.slice(0, size));
  const path = `${dir}/${name}`;
  await Deno.writeFile(path, bytes);
  return path;
}

async function inTempDir(body: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Размеры картинок, которые галерея отдала кадрами. */
async function sizes(gallery: Gallery): Promise<number[]> {
  const frames = await gallery.frames(0);
  return frames.map((frame) => atob(frame.data).length);
}

Deno.test("предел — 3 750 000 байт на ответ", () => {
  assertEquals(PICTURE_LIMIT, 3_750_000);
});

Deno.test("картинка файла — base64 его байтов (P1)", async () => {
  await inTempDir(async (dir) => {
    const gallery = new Gallery(PICTURE_LIMIT);
    gallery.offer(filePicture(await jpeg(dir, "43.jpg", 10)));
    assertEquals(await gallery.frames(0), [
      { mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    ]);
  });
});

Deno.test("граница предела (P11, P12)", async (t) => {
  for (const [size, shown] of [[3_750_000, 1], [3_750_001, 0]]) {
    await t.step(`${size} байт — картинок ${shown}`, async () => {
      await inTempDir(async (dir) => {
        const gallery = new Gallery(PICTURE_LIMIT);
        gallery.offer(filePicture(await jpeg(dir, "photo.jpg", size)));
        assertEquals((await gallery.frames(0)).length, shown);
      });
    });
  }
});

Deno.test("сумма по ответу: не поместившаяся предел не расходует (P13, P14)", async (t) => {
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
    await t.step(name, async () => {
      await inTempDir(async (dir) => {
        const gallery = new Gallery(PICTURE_LIMIT);
        for (const [at, size] of order.entries()) {
          gallery.offer(filePicture(await jpeg(dir, `${at}.jpg`, size)));
        }
        assertEquals(await sizes(gallery), kept);
      });
    });
  }
});

Deno.test("не картинка предел не расходует", async () => {
  await inTempDir(async (dir) => {
    const text = `${dir}/a.md`;
    await Deno.writeTextFile(text, "#".repeat(3_000_000));
    const gallery = new Gallery(PICTURE_LIMIT);
    gallery.offer(filePicture(text));
    gallery.offer(filePicture(await jpeg(dir, "b.jpg", 3_000_000)));
    assertEquals(await sizes(gallery), [3_000_000]);
  });
});

Deno.test("порядок картинок — порядок результатов", async () => {
  await inTempDir(async (dir) => {
    const png = `${dir}/b.png`;
    await Deno.writeFile(
      png,
      new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]),
    );
    const gallery = new Gallery(PICTURE_LIMIT);
    gallery.offer(filePicture(await jpeg(dir, "a.jpg", 10)));
    gallery.offer(NO_PICTURE);
    gallery.offer(filePicture(png));
    assertEquals((await gallery.frames(0)).map((frame) => frame.mime), [
      "image/jpeg",
      "image/png",
    ]);
  });
});

Deno.test("строка с кодом ≠ 0 — картинок нет, файлы не читаются (P19)", async () => {
  await inTempDir(async (dir) => {
    const gallery = new Gallery(PICTURE_LIMIT);
    let read = 0;
    gallery.offer({ addTo: () => Promise.resolve(void read++) });
    gallery.offer(filePicture(await jpeg(dir, "a.jpg", 10)));
    assertEquals(await gallery.frames(1), []);
    assertEquals(read, 0);
  });
});

Deno.test("не прочитать — картинки нет, отказа нет", async (t) => {
  await t.step("нет прав", () =>
    inTempDir(async (dir) => {
      const locked = await jpeg(dir, "locked.jpg", 10);
      await Deno.chmod(locked, 0o000);
      const gallery = new Gallery(PICTURE_LIMIT);
      gallery.offer(filePicture(locked));
      assertEquals(await gallery.frames(0), []);
    }));
  await t.step("не файл, а каталог", () =>
    inTempDir(async (dir) => {
      const gallery = new Gallery(PICTURE_LIMIT);
      gallery.offer(filePicture(dir));
      assertEquals(await gallery.frames(0), []);
    }));
});

Deno.test("предел — по прочитанным байтам, а не по размеру до чтения", async () => {
  const gallery = new Gallery(10);
  gallery.take("image/jpeg", new Uint8Array(11));
  gallery.take("image/png", new Uint8Array(10));
  assertEquals((await gallery.frames(0)).map((one) => one.mime), ["image/png"]);
});

Deno.test("файла к концу строки нет — картинки нет, отказа нет", async () => {
  await inTempDir(async (dir) => {
    const gallery = new Gallery(PICTURE_LIMIT);
    const gone = await jpeg(dir, "gone.jpg", 10);
    gallery.offer(filePicture(gone));
    await Deno.remove(gone);
    gallery.offer(filePicture(await jpeg(dir, "kept.jpg", 10)));
    assertEquals(await gallery.frames(0), [
      { mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    ]);
  });
});
