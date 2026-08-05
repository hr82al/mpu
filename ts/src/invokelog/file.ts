/**
 * Файл журнала вызовов (`platform/invoke-log.md`, «Побочные эффекты»):
 * дозапись записи и ротация. Файл общий с Python-реализацией, пока жив
 * маршрут `legacy`, поэтому ротацию обе стороны сериализуют одним
 * lock-файлом, а не своим механизмом.
 */

/**
 * Имя lock-файла — сосед журнала. Без суффикса `.log` осознанно: под
 * глоббинг архивов ротации оно не попадает.
 */
export const LOCK_NAME = "mpu.lock";

/** Сколько ждать лок ротации: не дождались — пишем без неё (спека). */
const LOCK_TIMEOUT_MS = 500;

/** Шаг опроса лока: своего события об освобождении flock не даёт. */
const LOCK_POLL_MS = 10;

/** Правила ротации файла журнала. */
export interface Rotation {
  /** Порог ротации в байтах; 0 — не ротировать. */
  readonly maxBytes: number;
  /** Число архивов; 0 — вместо ротации файл удаляется. */
  readonly keep: number;
}

/**
 * Дописывает запись в конец файла, при нужде ротируя его. Права 0600
 * задаются при каждой записи, а не только при создании файла: спека
 * требует выравнивания прав на каждой записи, и `mode` у `writeTextFile`
 * применяется к существующему файлу тоже (проверено тестом прав).
 */
export async function appendRecord(
  path: string,
  record: string,
  rotation: Rotation,
): Promise<void> {
  const dir = dirOf(path);
  await Deno.mkdir(dir, { recursive: true });
  try {
    await rotate(path, dir, rotation);
  } catch {
    // Ротация — обслуживание, запись — содержание: сбой первой не
    // должен стоить второй (спека, «Инварианты»). Причина сюда не
    // пробрасывается намеренно: единственный её потребитель — сам
    // журнал, а он обязан остаться fail-open.
  }
  await Deno.writeTextFile(path, record, {
    append: true,
    create: true,
    mode: 0o600,
  });
}

/** Ротация, если файл перерос порог. Пустой файл не ротируется никогда. */
async function rotate(
  path: string,
  dir: string,
  rotation: Rotation,
): Promise<void> {
  if (rotation.maxBytes <= 0) return;
  if (await sizeOf(path) < rotation.maxBytes) return;
  const lock = await Deno.open(`${dir}/${LOCK_NAME}`, {
    read: true,
    write: true,
    create: true,
    mode: 0o600,
  });
  try {
    await Deno.chmod(`${dir}/${LOCK_NAME}`, 0o600);
    if (!await waitLock(lock)) return;
    try {
      // Размер перечитывается под локом: пока мы ждали, файл мог
      // ротировать сосед — второй раз подряд ротировать нечего.
      if (await sizeOf(path) >= rotation.maxBytes) {
        await shift(path, rotation.keep);
      }
    } finally {
      await lock.unlock();
    }
  } finally {
    lock.close();
  }
}

/** Сдвиг архивов: `.1` → `.2` … ; `keep = 0` — файл просто удаляется. */
async function shift(path: string, keep: number): Promise<void> {
  if (keep === 0) {
    await shiftStep(() => Deno.remove(path));
    return;
  }
  await shiftStep(() => Deno.remove(`${path}.${keep}`));
  for (let index = keep - 1; index >= 1; index--) {
    await shiftStep(() =>
      Deno.rename(`${path}.${index}`, `${path}.${index + 1}`)
    );
  }
  await shiftStep(() => Deno.rename(path, `${path}.1`));
}

/** Шаг сдвига: архива с таким номером могло не быть — это норма. */
async function shiftStep(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Ждёт эксклюзивный лок не дольше отведённого времени. Опрос, а не
 * ожидание на `lock()`: у блокирующего варианта нет ни таймаута, ни
 * отмены, и незавершённый промис остался бы висеть после отказа ждать.
 */
async function waitLock(file: Deno.FsFile): Promise<boolean> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!await file.tryLock(true)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  return true;
}

/** Размер файла; файла нет — 0, ротировать нечего. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).size;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return 0;
    throw err;
  }
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "." : path.slice(0, cut);
}
