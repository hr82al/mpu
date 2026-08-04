/**
 * Разбор и построение текста dotenv env-файла
 * (`docs/specs/platform/env-file.md`, раздел «Ввод/вывод»). Модуль чистый:
 * без обращения к файловой системе — чтение и атомарную запись файла,
 * приоритет с переменными окружения процесса делает слой, который стоит
 * над этим кодом.
 */

const EXPORT_PREFIX = "export";

/** Значение непригодно для записи в env-файл. */
export class EnvValueError extends Error {
  override name = "EnvValueError";
}

/**
 * Текст файла с присвоением `ИМЯ=значение`: первая строка ключа
 * заменяется целиком, иначе строка дописывается в конец.
 * Бросает `EnvValueError`, если значение содержит перевод строки или
 * одинарную кавычку.
 */
export function assignEnvValue(
  text: string,
  name: string,
  value: string,
): string {
  if (value.includes("\n") || value.includes("'")) {
    throw new EnvValueError(
      "env value contains a newline or a single quote",
    );
  }

  const lines = text === "" ? [] : text.split("\n");
  // Разбиение по "\n" на файле с завершающим переводом строки даёт
  // хвостовую пустую строку — убираем её, чтобы не задваивать перевод
  // строки при сборке результата в конце функции.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const assignment = `${name}=${formatEnvValue(value)}`;
  const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(name)}\\s*=`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) {
    lines.push(assignment);
  } else {
    lines[index] = assignment;
  }

  return lines.join("\n") + "\n";
}

/** Форма значения: простое — как есть, иначе целиком в одинарных кавычках. */
function formatEnvValue(value: string): string {
  const isSimple = value !== "" && !/[\s#'"]/.test(value);
  return isSimple ? value : `'${value}'`;
}

/** Экранирует спецсимволы regex, чтобы имя ключа искалось как есть. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
