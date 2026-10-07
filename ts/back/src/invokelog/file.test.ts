import { assert, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, LOCK_NAME } from "./file.ts";

/** Временный каталог журнала с уборкой; путь файла — внутри него. */
async function withDir(
  body: (dir: string, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await body(dir, `${dir}/mpu.log`);
  } finally {
    await rm(dir, { recursive: true });
  }
}

const NO_ROTATION = { maxBytes: 0, keep: 5 } as const;

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

it("запись дописывается, каталог создаётся, права 0600", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/nested/mpu.log`;
    await appendRecord(path, "первая\n", NO_ROTATION);
    await appendRecord(path, "вторая\n", NO_ROTATION);
    expect(await readFile(path, "utf8")).toBe("первая\nвторая\n");
    expect(await modeOf(path)).toBe(0o600);
  });
});

it("права выравниваются при каждой записи", async () => {
  await withDir(async (_dir, path) => {
    await appendRecord(path, "a\n", NO_ROTATION);
    await chmod(path, 0o644);
    await appendRecord(path, "b\n", NO_ROTATION);
    expect(await modeOf(path)).toBe(0o600);
  });
});

describe("ротация по порогу", () => {
  it("файл уезжает в архив .1, новый начинается с записи", async () => {
    await withDir(async (_dir, path) => {
      await appendRecord(path, "старое\n", NO_ROTATION);
      await appendRecord(path, "новое\n", { maxBytes: 4, keep: 5 });
      expect(await readFile(path, "utf8")).toBe("новое\n");
      expect(await readFile(`${path}.1`, "utf8")).toBe("старое\n");
    });
  });
  it("архивы сдвигаются, лишний удаляется", async () => {
    await withDir(async (_dir, path) => {
      await writeFile(`${path}.1`, "арх1\n");
      await writeFile(`${path}.2`, "арх2\n");
      await appendRecord(path, "текущее\n", NO_ROTATION);
      await appendRecord(path, "свежее\n", { maxBytes: 4, keep: 2 });
      expect(await readFile(path, "utf8")).toBe("свежее\n");
      expect(await readFile(`${path}.1`, "utf8")).toBe("текущее\n");
      expect(await readFile(`${path}.2`, "utf8")).toBe("арх1\n");
      expect(await exists(`${path}.3`)).toBe(false);
    });
  });
  it("keep=0 — вместо ротации файл удаляется", async () => {
    await withDir(async (_dir, path) => {
      await appendRecord(path, "старое\n", NO_ROTATION);
      await appendRecord(path, "новое\n", { maxBytes: 4, keep: 0 });
      expect(await readFile(path, "utf8")).toBe("новое\n");
      expect(await exists(`${path}.1`)).toBe(false);
    });
  });
  it("пустой файл не ротируется", async () => {
    await withDir(async (_dir, path) => {
      await writeFile(path, "");
      await appendRecord(path, "новое\n", { maxBytes: 1, keep: 5 });
      expect(await readFile(path, "utf8")).toBe("новое\n");
      expect(await exists(`${path}.1`)).toBe(false);
    });
  });
  it("порог 0 — не ротировать никогда", async () => {
    await withDir(async (_dir, path) => {
      await appendRecord(path, "старое\n", NO_ROTATION);
      await appendRecord(path, "новое\n", NO_ROTATION);
      expect(await readFile(path, "utf8")).toBe("старое\nновое\n");
      expect(await exists(`${path}.1`)).toBe(false);
    });
  });
  it("файл ровно в порог ещё не ротируется", async () => {
    await withDir(async (_dir, path) => {
      await appendRecord(path, "12345", NO_ROTATION);
      await appendRecord(path, "6", { maxBytes: 6, keep: 5 });
      expect(await readFile(path, "utf8")).toBe("123456");
      expect(await exists(`${path}.1`)).toBe(false);
    });
  });
});

describe("сбой ротации не теряет запись", () => {
  it("архив не удалить — на его месте непустой каталог", async () => {
    await withDir(async (_dir, path) => {
      await mkdir(`${path}.5`);
      await writeFile(`${path}.5/занято`, "");
      await appendRecord(path, "старое\n", NO_ROTATION);
      await appendRecord(path, "новое\n", { maxBytes: 4, keep: 5 });
      expect(await readFile(path, "utf8")).toBe("старое\nновое\n");
    });
  });
  it("каталог журнала закрыт правами — отказ записи", async () => {
    await withDir(async (dir) => {
      const closed = `${dir}/закрыто`;
      await mkdir(closed);
      await writeFile(`${closed}/mpu.log`, "старое\n");
      await chmod(closed, 0o000);
      try {
        // Читать размер для ротации нечем, писать тоже некуда: наружу
        // уходит отказ, а fail-open — этажом выше, в самом журнале.
        await expect(appendRecord(`${closed}/mpu.log`, "новое\n", {
          maxBytes: 1,
          keep: 5,
        })).rejects.toThrow();
      } finally {
        await chmod(closed, 0o755);
      }
    });
  });
});

it("две записи разом: обе целы, ни одна не разрезана", async () => {
  await withDir(async (_dir, path) => {
    // Мегабайт на запись: две одновременно кончившиеся строки сервера
    // пишут в один файл (`platform/line-concurrency.md`). Целостность
    // держится поведением ядра — запись в файл, открытый на дозапись,
    // уходит одним обращением и не режется, — а не нашим замком;
    // сменится способ записи или файловая система, и этот тест первым
    // об этом скажет.
    const first = `${"а".repeat(1024 * 1024)}\n`;
    const second = `${"б".repeat(1024 * 1024)}\n`;
    await Promise.all([
      appendRecord(path, first, NO_ROTATION),
      appendRecord(path, second, NO_ROTATION),
    ]);
    const text = await readFile(path, "utf8");
    // Порядок между одновременными записями не определён, целостность —
    // определена: файл ровно из двух записей.
    expect(text.length).toStrictEqual(first.length + second.length);
    expect(
      text === first + second || text === second + first,
      "записи перемешались",
    ).toBe(true);
  });
});

it("лок занят: запись не теряется, ротации нет", async () => {
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
      expect(await readFile(path, "utf8")).toBe("старое\nновое\n");
      expect(await exists(`${path}.1`)).toBe(false);
    } finally {
      await held.unlock();
      held.close();
    }
  });
});

it("lock-файл — сосед журнала с правами 0600", async () => {
  await withDir(async (dir, path) => {
    // Файл общий с Python-реализацией: он мог создать его с другими
    // правами, и они выравниваются при каждой записи (спека).
    await writeFile(`${dir}/${LOCK_NAME}`, "", { mode: 0o644 });
    await chmod(`${dir}/${LOCK_NAME}`, 0o644);
    await appendRecord(path, "старое\n", NO_ROTATION);
    await appendRecord(path, "новое\n", { maxBytes: 4, keep: 5 });
    expect(await modeOf(`${dir}/${LOCK_NAME}`)).toBe(0o600);
    // Имя без суффикса `.log`: под глоббинг архивов оно не попадает.
    assert(!LOCK_NAME.includes(".log"));
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
