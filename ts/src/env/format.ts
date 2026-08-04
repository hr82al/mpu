/**
 * Разбор формата dotenv env-файла (`docs/specs/platform/env-file.md`,
 * раздел «Ввод/вывод»). Модуль чистый: без обращения к файловой системе —
 * чтение файла и приоритет с переменными окружения процесса делает слой,
 * который стоит над этим разбором.
 */

const EXPORT_PREFIX = "export";

/** Разбор dotenv: имя → значение. Дубликат ключа — побеждает последний. */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = stripExportPrefix(line);
    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex === -1) continue;

    const name = withoutExport.slice(0, eqIndex).trim();
    if (name === "") continue;

    result[name] = parseValue(withoutExport.slice(eqIndex + 1));
  }
  return result;
}

/** Снимает префикс `export`, только если сразу за ним пробельный символ. */
function stripExportPrefix(line: string): string {
  const afterPrefix = line[EXPORT_PREFIX.length];
  const hasSeparator = afterPrefix !== undefined && /\s/.test(afterPrefix);
  if (line.startsWith(EXPORT_PREFIX) && hasSeparator) {
    return line.slice(EXPORT_PREFIX.length);
  }
  return line;
}

/** Разбирает часть строки после `=` по правилам кавычек и комментария. */
function parseValue(rawValue: string): string {
  const value = rawValue.trimStart();
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    const closeIndex = value.indexOf(quote, 1);
    if (closeIndex !== -1) {
      // Содержимое между кавычками — литерал: `#` внутри не режется, а
      // экранирование (`\n`, `\"` и т.п.) внутри двойных кавычек не
      // обрабатывается — спека гарантирует только сам факт кавычек, не
      // shell-подобную семантику экранирования внутри них.
      return value.slice(1, closeIndex);
    }
    // Незакрытая кавычка: второй такой же кавычки до конца строки нет,
    // значит границы значения не определены контрактом. Не бросаем
    // ошибку разбора файла целиком ради одной кривой строки — откатываемся
    // к безкавычному разбору вместе с открывающим символом кавычки, он
    // остаётся частью значения как обычный символ.
  }
  return stripUnquotedComment(value);
}

/** Отрезает хвостовой комментарий безкавычного значения и его отступ. */
function stripUnquotedComment(value: string): string {
  // Спека молчит о `#` без предшествующего пробела — golden-пример такого
  // случая не содержит. Решение: считать его частью значения, а не
  // комментарием, — иначе `#` внутри URL (хэш-фрагмент вида
  // `https://…#section`) или произвольного токена без пробелов
  // (`va#lue`) резался бы посимвольно, хотя это не комментарий.
  const spaceHashIndex = value.search(/\s#/);
  const withoutComment = spaceHashIndex === -1
    ? value
    : value.slice(0, spaceHashIndex);
  return withoutComment.trimEnd();
}
