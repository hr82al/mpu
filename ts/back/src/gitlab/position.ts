/**
 * Position инлайн-комментария (`platform/gitlab-api.md`, «Position
 * инлайн-комментария»): выбор строки диффа и form-ключи привязки.
 *
 * Здесь живёт самая хрупкая часть семейства. Промах не выглядит
 * промахом: GitLab принимает POST с неполной или неверной позицией и
 * отвечает успехом, а комментарий повисает в MR сам по себе, без
 * привязки к строке. Поэтому строка сначала ищется в разобранном
 * диффе, и только найденная превращается в ключи; чего нет в диффе,
 * то не отправляется.
 */

import { type DiffLine, parseDiffLines } from "./diff.ts";
import type { ChangedFile, DiffRefs } from "./model.ts";

/** Сторона адресации: правая колонка диффа либо левая. */
export type DiffSide = "new" | "old";

/** Номер строки на стороне; у чужой стороны его нет. */
function lineOn(line: DiffLine, side: DiffSide): number | undefined {
  return side === "new" ? line.newLine : line.oldLine;
}

/**
 * Строка файла, адресуемая выбранной стороной. Removed-строки нет на
 * new-стороне, added — на old-стороне: это не фильтр «на всякий
 * случай», а само определение сторон.
 */
export function findLine(
  file: ChangedFile,
  side: DiffSide,
  line: number,
): DiffLine | undefined {
  return parseDiffLines(file.diff)
    .find((candidate) => lineOn(candidate, side) === line);
}

/** Номера, которые сторона вообще позволяет прокомментировать. */
export function commentableLines(
  file: ChangedFile,
  side: DiffSide,
): readonly number[] {
  const numbers = parseDiffLines(file.diff)
    .map((line) => lineOn(line, side))
    .filter((number): number is number => number !== undefined);
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/**
 * Диапазоны стороны текстом: `10-12, 240`. Оператору нужен не список
 * из сотни номеров, а границы, в которые он может целиться.
 */
export function rangesText(numbers: readonly number[]): string {
  const ranges: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  const flush = () => {
    if (start === undefined || previous === undefined) return;
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  };
  for (const number of numbers) {
    if (previous !== undefined && number === previous + 1) {
      previous = number;
      continue;
    }
    flush();
    start = number;
    previous = number;
  }
  flush();
  return ranges.join(", ");
}

/**
 * Form-ключи позиции. Оба пути присутствуют всегда — это закрывает
 * переименование, — а номера зависят от типа строки: added несёт
 * только new_line, removed — только old_line, а context обе, потому
 * что неизменённую строку GitLab без обеих не принимает.
 *
 * Пути берутся из файла MR, а не из того, что набрал оператор: в
 * переименованном файле он назовёт одно из двух имён, а привязка
 * требует ровно тех, что знает GitLab.
 */
export function positionForm(
  refs: DiffRefs,
  file: ChangedFile,
  line: DiffLine,
): Readonly<Record<string, string>> {
  const form: Record<string, string> = {
    "position[position_type]": "text",
    "position[base_sha]": refs.base_sha,
    "position[start_sha]": refs.start_sha,
    "position[head_sha]": refs.head_sha,
    "position[old_path]": file.old_path,
    "position[new_path]": file.new_path,
  };
  if (line.oldLine !== undefined) {
    form["position[old_line]"] = String(line.oldLine);
  }
  if (line.newLine !== undefined) {
    form["position[new_line]"] = String(line.newLine);
  }
  return form;
}
