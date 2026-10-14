/**
 * Текст ответа команды по файлам (`file_survey.ts`): по разделу на
 * репозиторий, между ними пустая строка. Внутри раздела — шапка без
 * гарантии, файлы строками команды, «не разрешено».
 */

import { treeMarkOf } from "./answer.ts";
import type { Part, SurveyResult, SurveySection } from "./file_survey.ts";
import { renderMarkOnly } from "./mark.ts";

/** Текст ответа; строки файла печатает команда. */
export function renderSurvey<F>(
  result: SurveyResult<F>,
  fileLines: (file: F) => readonly string[],
): string {
  const sections = result.sections.map((section) =>
    renderSection(section, fileLines),
  );
  return `${sections.join("\n\n")}\n`;
}

function renderSection<F>(
  section: SurveySection<F>,
  fileLines: (file: F) => readonly string[],
): string {
  return [
    renderMarkOnly(treeMarkOf(section.mark)),
    ...section.files.flatMap(fileLines),
    ...block(
      "не разрешено",
      section.unresolved,
      (item) => `${item.path}: ${item.reason}`,
    ),
  ].join("\n");
}

/** Раздел: заголовок со счётчиком, записи с отступом, усечение. */
export function block<T>(
  title: string,
  part: Part<T>,
  line: (item: T) => string,
): readonly string[] {
  const lines = part.items.map((item) => `  ${line(item)}`);
  if (part.items.length < part.total) {
    lines.push(`  усечено: показано ${part.items.length} из ${part.total}`);
  }
  return [`${title}: ${part.total}`, ...lines];
}
