/**
 * Снимок дерева на диске (`platform/back-rpc.md`, «Снимок дерева»):
 * записывается атомарно — читатель видит прежний файл или новый целиком.
 */

/** Файловые операции записи снимка. */
export interface SnapshotFs {
  mkdir(dir: string): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Файловая система процесса. */
export const DENO_FS: SnapshotFs = {
  mkdir: (dir) => Deno.mkdir(dir, { recursive: true }),
  writeTextFile: (path, text) => Deno.writeTextFile(path, text),
  rename: (from, to) => Deno.rename(from, to),
  remove: (path) => Deno.remove(path),
};

/**
 * Пишет `text` в `file`: временный файл рядом и переименование.
 *
 * @param file путь снимка; `undefined` — нет HOME
 * @param text содержимое
 * @param fs файловые операции
 * @returns причина неудачи; записано — `undefined`
 */
export async function writeSnapshot(
  file: string | undefined,
  text: string,
  fs: SnapshotFs = DENO_FS,
): Promise<string | undefined> {
  if (file === undefined) return "каталог кэша не задан (нет HOME)";
  const cut = file.lastIndexOf("/");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    if (cut > 0) await fs.mkdir(file.slice(0, cut));
    await fs.writeTextFile(temp, text);
    await fs.rename(temp, file);
    return undefined;
  } catch (err) {
    await fs.remove(temp).catch(() => {
      // Временного файла нет (не создан) или убрать нельзя: причину
      // неудачи уже несёт исходная ошибка, вторая её бы заслонила.
    });
    return err instanceof Error ? err.message : String(err);
  }
}
