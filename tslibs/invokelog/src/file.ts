/**
 * Файл журнала вызовов (`platform/invoke-log.md`, «Побочные эффекты»):
 * дозапись записи и ротация. Пишут его разом несколько процессов (сервер
 * строк, исполнители), поэтому ротацию между ними сериализует лок
 * `mpu.lock` рядом с журналом.
 */

import { Buffer } from "node:buffer";
import { lstat, mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import { hasErrorCode } from "@mpu/base/oserror";

/**
 * Имя лока ротации — сосед журнала. Без суффикса `.log` осознанно: под
 * глоббинг архивов ротации оно не попадает.
 */
export const LOCK_NAME = "mpu.lock";

/** Сколько ждать лок ротации: не дождались — пишем без неё (спека). */
const LOCK_TIMEOUT_MS = 500;

/** Шаг опроса лока: события об освобождении у лока-каталога нет. */
const LOCK_POLL_MS = 10;

/**
 * Через сколько чужой лок считается брошенным: держатель умер посреди
 * ротации. Живой держатель обновляет отметку вдвое чаще, а ротация —
 * несколько переименований, на порядки короче.
 */
const LOCK_STALE_MS = 10_000;

/**
 * Часть поверхности `proper-lockfile`, которой пользуется ротация.
 * Своих типов пакет не несёт — поверхность объявлена здесь, как у `pg`.
 */
interface LockFiles {
  lock(
    file: string,
    options: {
      readonly lockfilePath: string;
      readonly realpath: false;
      readonly retries: 0;
      readonly stale: number;
      readonly onCompromised: (err: Error) => void;
    },
  ): Promise<() => Promise<void>>;
}

/** Снятие лока ротации. */
type Release = () => Promise<void>;

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
 * требует выравнивания прав на каждой записи, а `mode` у `open`
 * действует только на создаваемый файл — отсюда `chmod` следом
 * (проверено тестом прав).
 */
export async function appendRecord(
  path: string,
  record: string,
  rotation: Rotation,
): Promise<void> {
  const dir = dirOf(path);
  await mkdir(dir, { recursive: true });
  try {
    await rotate(path, dir, rotation);
  } catch {
    // Ротация — обслуживание, запись — содержание: сбой первой не
    // должен стоить второй (спека, «Инварианты»). Причина сюда не
    // пробрасывается намеренно: единственный её потребитель — сам
    // журнал, а он обязан остаться fail-open.
  }
  // Замка на самой записи нет намеренно: запись уходит в файл,
  // открытый на дозапись, одним обращением к ядру и не режется — замер
  // 2026-09-21 в `platform/line-concurrency.md`, «Инварианты». Поэтому
  // буфер целиком одним `write`, а не `appendFile`: тот пишет кусками.
  // Сменится способ записи или файловая система — целостность проверять
  // заново.
  const file = await open(path, "a", 0o600);
  try {
    await file.chmod(0o600);
    // Короткая запись дописывается остатком, а не теряет хвост молча.
    const bytes = Buffer.from(record);
    let written = 0;
    while (written < bytes.length) {
      written += (await file.write(bytes, written)).bytesWritten;
    }
  } finally {
    await file.close();
  }
}

/** Ротация, если файл перерос порог. Пустой файл не ротируется никогда. */
async function rotate(
  path: string,
  dir: string,
  rotation: Rotation,
): Promise<void> {
  if (rotation.maxBytes <= 0) return;
  if ((await sizeOf(path)) < rotation.maxBytes) return;
  const release = await waitLock(dir);
  if (release === undefined) return;
  try {
    // Размер перечитывается под локом: пока мы ждали, файл мог
    // ротировать сосед — второй раз подряд ротировать нечего.
    if ((await sizeOf(path)) >= rotation.maxBytes) {
      await shift(path, rotation.keep);
    }
  } finally {
    await release();
  }
}

/** Сдвиг архивов: `.1` → `.2` … ; `keep = 0` — файл просто удаляется. */
async function shift(path: string, keep: number): Promise<void> {
  if (keep === 0) {
    await shiftStep(() => rm(path));
    return;
  }
  await shiftStep(() => rm(`${path}.${keep}`));
  for (let index = keep - 1; index >= 1; index--) {
    await shiftStep(() => rename(`${path}.${index}`, `${path}.${index + 1}`));
  }
  await shiftStep(() => rename(path, `${path}.1`));
}

/** Шаг сдвига: архива с таким номером могло не быть — это норма. */
async function shiftStep(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) throw err;
  }
}

/**
 * Берёт лок ротации — каталог `mpu.lock` (`proper-lockfile`: `mkdir`
 * атомарен между процессами, flock у `node:fs` нет; решение владельца
 * 2026-10-07, `platform/node-runtime.md` [S.7]) — не дольше отведённого
 * времени; не взят — `undefined`, и запись идёт без ротации.
 *
 * Пакет грузится здесь, а не при старте: ротация редка, а его
 * `graceful-fs` при загрузке подменяет `fs.close` процесса.
 */
async function waitLock(dir: string): Promise<Release | undefined> {
  const lockfile = (await import("proper-lockfile")).default as LockFiles;
  const lockPath = `${dir}/${LOCK_NAME}`;
  await dropFileLock(lockPath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return await lockfile.lock(dir, {
        lockfilePath: lockPath,
        realpath: false,
        retries: 0,
        stale: LOCK_STALE_MS,
        // Лок перехвачен как брошенный — ротация шла дольше порога.
        // Журнал обязан остаться fail-open (спека), а умолчание пакета
        // бросает из таймера и роняет процесс.
        onCompromised: () => {},
      });
    } catch (err) {
      if (!isHeld(err)) throw err;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/** Лок держит другой процесс: ждать, а не отказывать. */
function isHeld(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ELOCKED";
}

/**
 * Лок прежней сборки — обычный файл `mpu.lock` (flock): он остаётся на
 * диске навсегда, и `mkdir` на его месте отвечал бы «занято», а через
 * порог брошенности — `ENOTDIR`, то есть ротация не случилась бы
 * больше никогда. Удаляется только файл: живой лок соседа — каталог, и
 * `unlink` под Deno удаляет пустой каталог, а не отказывает `EISDIR`.
 */
async function dropFileLock(lockPath: string): Promise<void> {
  try {
    if (!(await lstat(lockPath)).isFile()) return;
    await unlink(lockPath);
  } catch (err) {
    // Сосед убрал файл раньше нас (`ENOENT`) или успел взять лок-каталог
    // между проверкой и удалением (`EISDIR`, на macOS `EPERM`) — убирать
    // нечего. Под Deno то же окно удалило бы пустой каталог соседа; оно
    // открыто только пока на диске лежит файл прежней сборки.
    if (!hasErrorCode(err, "ENOENT", "EISDIR", "EPERM")) throw err;
  }
}

/** Размер файла; файла нет — 0, ротировать нечего. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return 0;
    throw err;
  }
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "." : path.slice(0, cut);
}
