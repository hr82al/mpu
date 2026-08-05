import { assert, assertEquals, assertRejects } from "@std/assert";
import { appendRecord, LOCK_NAME } from "./file.ts";

/** Временный каталог журнала с уборкой; путь файла — внутри него. */
async function withDir(
  body: (dir: string, path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await body(dir, `${dir}/mpu.log`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const NO_ROTATION = { maxBytes: 0, keep: 5 } as const;

async function modeOf(path: string): Promise<number | null> {
  const info = await Deno.stat(path);
  return info.mode === null ? null : info.mode & 0o777;
}

Deno.test("запись дописывается, каталог создаётся, права 0600", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/nested/mpu.log`;
    await appendRecord(path, "первая\n", NO_ROTATION);
    await appendRecord(path, "вторая\n", NO_ROTATION);
    assertEquals(await Deno.readTextFile(path), "первая\nвторая\n");
    assertEquals(await modeOf(path), 0o600);
  });
});

Deno.test("права выравниваются при каждой записи", async () => {
  await withDir(async (_dir, path) => {
    await appendRecord(path, "a\n", NO_ROTATION);
    await Deno.chmod(path, 0o644);
    await appendRecord(path, "b\n", NO_ROTATION);
    assertEquals(await modeOf(path), 0o600);
  });
});

Deno.test("ротация по порогу", async (t) => {
  await t.step(
    "файл уезжает в архив .1, новый начинается с записи",
    async () => {
      await withDir(async (_dir, path) => {
        await appendRecord(path, "старое\n", NO_ROTATION);
        await appendRecord(path, "новое\n", { maxBytes: 4, keep: 5 });
        assertEquals(await Deno.readTextFile(path), "новое\n");
        assertEquals(await Deno.readTextFile(`${path}.1`), "старое\n");
      });
    },
  );
  await t.step("архивы сдвигаются, лишний удаляется", async () => {
    await withDir(async (_dir, path) => {
      await Deno.writeTextFile(`${path}.1`, "арх1\n");
      await Deno.writeTextFile(`${path}.2`, "арх2\n");
      await appendRecord(path, "текущее\n", NO_ROTATION);
      await appendRecord(path, "свежее\n", { maxBytes: 4, keep: 2 });
      assertEquals(await Deno.readTextFile(path), "свежее\n");
      assertEquals(await Deno.readTextFile(`${path}.1`), "текущее\n");
      assertEquals(await Deno.readTextFile(`${path}.2`), "арх1\n");
      assertEquals(await exists(`${path}.3`), false);
    });
  });
  await t.step("keep=0 — вместо ротации файл удаляется", async () => {
    await withDir(async (_dir, path) => {
      await appendRecord(path, "старое\n", NO_ROTATION);
      await appendRecord(path, "новое\n", { maxBytes: 4, keep: 0 });
      assertEquals(await Deno.readTextFile(path), "новое\n");
      assertEquals(await exists(`${path}.1`), false);
    });
  });
  await t.step("пустой файл не ротируется", async () => {
    await withDir(async (_dir, path) => {
      await Deno.writeTextFile(path, "");
      await appendRecord(path, "новое\n", { maxBytes: 1, keep: 5 });
      assertEquals(await Deno.readTextFile(path), "новое\n");
      assertEquals(await exists(`${path}.1`), false);
    });
  });
  await t.step("порог 0 — не ротировать никогда", async () => {
    await withDir(async (_dir, path) => {
      await appendRecord(path, "старое\n", NO_ROTATION);
      await appendRecord(path, "новое\n", NO_ROTATION);
      assertEquals(await Deno.readTextFile(path), "старое\nновое\n");
      assertEquals(await exists(`${path}.1`), false);
    });
  });
  await t.step("файл ровно в порог ещё не ротируется", async () => {
    await withDir(async (_dir, path) => {
      await appendRecord(path, "12345", NO_ROTATION);
      await appendRecord(path, "6", { maxBytes: 6, keep: 5 });
      assertEquals(await Deno.readTextFile(path), "123456");
      assertEquals(await exists(`${path}.1`), false);
    });
  });
});

Deno.test("сбой ротации не теряет запись", async (t) => {
  await t.step("архив не удалить — на его месте непустой каталог", async () => {
    await withDir(async (_dir, path) => {
      await Deno.mkdir(`${path}.5`);
      await Deno.writeTextFile(`${path}.5/занято`, "");
      await appendRecord(path, "старое\n", NO_ROTATION);
      await appendRecord(path, "новое\n", { maxBytes: 4, keep: 5 });
      assertEquals(await Deno.readTextFile(path), "старое\nновое\n");
    });
  });
  await t.step("каталог журнала закрыт правами — отказ записи", async () => {
    await withDir(async (dir) => {
      const closed = `${dir}/закрыто`;
      await Deno.mkdir(closed);
      await Deno.writeTextFile(`${closed}/mpu.log`, "старое\n");
      await Deno.chmod(closed, 0o000);
      try {
        // Читать размер для ротации нечем, писать тоже некуда: наружу
        // уходит отказ, а fail-open — этажом выше, в самом журнале.
        await assertRejects(() =>
          appendRecord(`${closed}/mpu.log`, "новое\n", {
            maxBytes: 1,
            keep: 5,
          })
        );
      } finally {
        await Deno.chmod(closed, 0o755);
      }
    });
  });
});

Deno.test("лок занят: запись не теряется, ротации нет", async () => {
  await withDir(async (dir, path) => {
    await appendRecord(path, "старое\n", NO_ROTATION);
    const held = await Deno.open(`${dir}/${LOCK_NAME}`, {
      read: true,
      write: true,
      create: true,
    });
    try {
      await held.lock(true);
      await appendRecord(path, "новое\n", { maxBytes: 4, keep: 5 });
      // Ротация не состоялась — запись всё равно на месте, дописана к
      // прежнему содержимому.
      assertEquals(await Deno.readTextFile(path), "старое\nновое\n");
      assertEquals(await exists(`${path}.1`), false);
    } finally {
      await held.unlock();
      held.close();
    }
  });
});

Deno.test("lock-файл — сосед журнала с правами 0600", async () => {
  await withDir(async (dir, path) => {
    // Файл общий с Python-реализацией: он мог создать его с другими
    // правами, и они выравниваются при каждой записи (спека).
    await Deno.writeTextFile(`${dir}/${LOCK_NAME}`, "", { mode: 0o644 });
    await Deno.chmod(`${dir}/${LOCK_NAME}`, 0o644);
    await appendRecord(path, "старое\n", NO_ROTATION);
    await appendRecord(path, "новое\n", { maxBytes: 4, keep: 5 });
    assertEquals(await modeOf(`${dir}/${LOCK_NAME}`), 0o600);
    // Имя без суффикса `.log`: под глоббинг архивов оно не попадает.
    assert(!LOCK_NAME.includes(".log"));
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
