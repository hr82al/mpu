/**
 * Разбор unified diff одного файла (`platform/gitlab-api.md`,
 * «Разбор unified diff»): строка → сторона и номер.
 *
 * Номера строк нужны не счётчикам `mr files`, а адресации инлайн-
 * комментария: added адресуется только new-стороной, removed — только
 * old-, context — обеими. Считать их отдельно от классификации строк
 * нельзя: обе величины падают из одного прохода, и разойтись им
 * нечем — потому счётчики и живут поверх разбора, а не рядом с ним.
 */

/** Вид строки диффа; он же определяет, какой стороной она адресуема. */
export type DiffLineKind = "added" | "removed" | "context";

/** Одна строка диффа: вид, номера сторон и текст без ведущего знака. */
export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Номер на левой стороне; у added его нет. */
  readonly oldLine: number | undefined;
  /** Номер на правой стороне; у removed его нет. */
  readonly newLine: number | undefined;
  readonly text: string;
}

/** Счётчики файла для таблицы `mr files` и её хвоста. */
export interface DiffCounts {
  readonly additions: number;
  readonly deletions: number;
}

/** Заголовок hunk'а: с него начинаются номера обеих сторон. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Строки диффа по порядку. Всё до первого hunk-заголовка —
 * служебная шапка (`--- a/…`, `+++ b/…`, `index …`), и пропускается
 * она именно поэтому: `+++` иначе стал бы added-строкой и сдвинул все
 * номера правой стороны на единицу.
 *
 * Пустой diff (binary-файл) даёт ноль строк, а не отказ: у GitLab это
 * штатная форма ответа.
 */
export function parseDiffLines(diff: string): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  // Поле `diff` кончается переводом строки, и последний кусок split —
  // пустая строка ЗА концом файла. Считать её контекстом значило бы
  // выдать адресуемую строку, которой в файле нет: инлайн-комментарий
  // на неё GitLab либо отвергнет, либо поставит не туда.
  const body = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  let oldLine = 0;
  let newLine = 0;
  let started = false;
  for (const raw of body.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      started = true;
      continue;
    }
    if (!started) continue;
    // «\ No newline at end of file» — не строка файла, а примечание к
    // предыдущей: номер ей не принадлежит ни на одной стороне.
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      lines.push({
        kind: "added",
        oldLine: undefined,
        newLine,
        text: raw.slice(1),
      });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({
        kind: "removed",
        oldLine,
        newLine: undefined,
        text: raw.slice(1),
      });
      oldLine += 1;
      continue;
    }
    // Любая прочая строка — контекст, включая полностью пустую: так
    // велит спека атома. Пустая строка внутри hunk'а — неизменённая
    // пустая строка файла, и оба номера она обязана двигать.
    lines.push({
      kind: "context",
      oldLine,
      newLine,
      text: raw.startsWith(" ") ? raw.slice(1) : raw,
    });
    oldLine += 1;
    newLine += 1;
  }
  return lines;
}

/** Счётчики `+N`/`-M` файла: те же строки, что у разбора. */
export function countDiff(diff: string): DiffCounts {
  let additions = 0;
  let deletions = 0;
  for (const line of parseDiffLines(diff)) {
    if (line.kind === "added") additions += 1;
    else if (line.kind === "removed") deletions += 1;
  }
  return { additions, deletions };
}
