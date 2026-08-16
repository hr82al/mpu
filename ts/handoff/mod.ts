/**
 * Ячейка передачи работы между двумя сессиями.
 *
 * В ячейке в каждый момент лежит ровно одно: либо постановка порции, либо
 * отчёт о ней. Первая строка — маркер, по нему читающая сторона понимает, что
 * перед ней, не разбирая текст. Запись — всегда полная перезапись: дописывание
 * в конец слепляет постановку с отчётом, и адресат перестаёт различать, что
 * из этого ему.
 */

/** Что лежит в ячейке. */
export type Kind = "task" | "report";

/** Маркер первой строки для каждого вида содержимого. */
export const MARKER: Record<Kind, string> = {
  task: "# ЗАДАНИЕ",
  report: "# ОТЧЁТ",
};

/** Содержимое ячейки: вид, текст целиком, число строк. */
export type Cell = {
  readonly kind: Kind;
  readonly text: string;
  readonly lines: number;
};

/** Ячейка пуста или первая строка не маркер — разбирать нечего. */
export class CellError extends Error {
  override readonly name = "CellError";
}

/** Разобрать текст ячейки. Вид определяет ровно первая строка. */
export function parseCell(text: string): Cell {
  const first = text.split("\n", 1)[0].trim();
  const kind = (Object.keys(MARKER) as Kind[]).find((k) => MARKER[k] === first);
  if (kind === undefined) {
    throw new CellError(
      text.trim() === ""
        ? "ячейка пуста — ни постановки, ни отчёта"
        : `первая строка '${first}' не маркер; ожидается '${MARKER.task}' или '${MARKER.report}'`,
    );
  }
  return { kind, text, lines: text.split("\n").length };
}

/** Прочитать ячейку с диска. Файла нет — та же ошибка, что и у пустой. */
export async function readCell(path: string): Promise<Cell> {
  try {
    return parseCell(await Deno.readTextFile(path));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new CellError(`ячейки ${path} нет — работа ещё не передавалась`);
    }
    throw err;
  }
}

/**
 * Положить содержимое в ячейку вместо прежнего.
 *
 * Пишет во временный файл рядом и переименовывает: читающая сторона либо видит
 * старое целиком, либо новое целиком, но никогда не половину.
 */
export async function writeCell(
  path: string,
  kind: Kind,
  body: string,
): Promise<Cell> {
  const text = body.startsWith(MARKER[kind])
    ? body
    : `${MARKER[kind]}\n\n${body.replace(/^\s+/, "")}`;
  const temp = `${path}.new`;
  await Deno.writeTextFile(temp, text.endsWith("\n") ? text : `${text}\n`);
  await Deno.rename(temp, path);
  return parseCell(text);
}

/**
 * Дождаться, пока в ячейке окажется содержимое нужного вида.
 *
 * Опрос, а не слежение за файлом: ячейку переписывают раз в несколько часов,
 * и простой цикл переживает и переезд файла, и его временное отсутствие.
 */
export async function waitFor(
  path: string,
  kind: Kind,
  options: { readonly everyMs: number; readonly timeoutMs: number },
): Promise<Cell> {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    const cell = await readCell(path).catch((err) => {
      if (err instanceof CellError) return null;
      throw err;
    });
    if (cell?.kind === kind) return cell;
    if (performance.now() >= deadline) {
      throw new CellError(
        `${MARKER[kind]} не появился за ${
          Math.round(options.timeoutMs / 1000)
        } с`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.everyMs));
  }
}
