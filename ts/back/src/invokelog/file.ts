/**
 * Файл журнала вызовов (`platform/invoke-log.md`, «Побочные эффекты»):
 * дозапись записи и ротация. Файл общий с Python-реализацией: она
 * установлена рядом и пишет в него сама, когда её зовут напрямую (наш
 * маршрут `legacy` снят порцией 97). Поэтому ротацию обе стороны
 * сериализуют одним lock-файлом, а не своим механизмом.
 */

import { Buffer } from "node:buffer";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { hasErrorCode } from "../oserror/mod.ts";

/**
 * Имя lock-файла — сосед журнала. Без суффикса `.log` осознанно: под
 * глоббинг архивов ротации оно не попадает.
 */
export const LOCK_NAME = "mpu.lock";

/** Сколько ждать лок ротации: не дождались — пишем без неё (спека). */
const LOCK_TIMEOUT_MS = 500;

/** Шаг опроса лока: своего события об освобождении лок не даёт. */
const LOCK_POLL_MS = 10;

/** Снять взятый лок. */
type Release = () => Promise<void>;

/**
 * Та часть `proper-lockfile`, что берёт ротация: у пакета нет своих типов,
 * и без этого описания импорт молча был бы `any`.
 */
interface LockLibrary {
  lock(
    path: string,
    options: {
      readonly realpath: boolean;
      readonly retries: {
        readonly retries: number;
        readonly factor: number;
        readonly minTimeout: number;
        readonly maxTimeout: number;
        readonly maxRetryTime: number;
      };
    },
  ): Promise<Release>;
}

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
    await file.write(Buffer.from(record));
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
  if (await sizeOf(path) < rotation.maxBytes) return;
  const lockPath = `${dir}/${LOCK_NAME}`;
  // Сам lock-файл — по-прежнему файл 0600 (спека); лок `proper-lockfile`
  // — каталог рядом с ним (`mpu.lock.lock`): у прежних версий `mpu.lock`
  // уже лежит обычным файлом, и каталог на его месте не создать.
  await appendFile(lockPath, "", { mode: 0o600 });
  await chmod(lockPath, 0o600);
  const release = await waitLock(lockPath);
  if (release === undefined) return;
  try {
    // Размер перечитывается под локом: пока мы ждали, файл мог
    // ротировать сосед — второй раз подряд ротировать нечего.
    if (await sizeOf(path) >= rotation.maxBytes) {
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
 * Ждёт эксклюзивный лок не дольше отведённого времени; не дождался —
 * `undefined`. Опрос с шагом и потолком по времени — у
 * `proper-lockfile` своего ожидания освобождения нет. Библиотека
 * грузится только здесь: при загрузке она вешает обработчики сигналов
 * процесса и подменяет `fs.close`, а ротация — редкая ветка.
 */
async function waitLock(path: string): Promise<Release | undefined> {
  // Пакет CommonJS без типов: его `module.exports` — это `default`
  // импорта, а форма описана `LockLibrary` по исходнику версии 4.1.2.
  const library = (await import("proper-lockfile")).default as LockLibrary;
  try {
    return await library.lock(path, {
      realpath: false,
      retries: {
        retries: Math.ceil(LOCK_TIMEOUT_MS / LOCK_POLL_MS),
        factor: 1,
        minTimeout: LOCK_POLL_MS,
        maxTimeout: LOCK_POLL_MS,
        maxRetryTime: LOCK_TIMEOUT_MS,
      },
    });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ELOCKED") {
      return undefined;
    }
    throw err;
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
