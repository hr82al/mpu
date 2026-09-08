/**
 * Адрес цели `[РЕПОЗИТОРИЙ:]ПУТЬ[:СТРОКА]` (`specs/code-refs.md`).
 *
 * Две формы адреса — две цели: со строкой спрашивают про символ,
 * объявленный в ней, без строки — про модуль. Разбор чисто
 * синтаксический: существование пути и строки проверяет уже анализатор,
 * которому известно дерево.
 */

import { UsageError } from "../command/mod.ts";

/** Разобранный адрес; репозиторий опущен — `undefined`. */
export interface Address {
  readonly repo: string | undefined;
  readonly path: string;
  /** Строка объявления; без неё цель — модуль. */
  readonly line: number | undefined;
}

/**
 * Путь внутри репозитория в нормальной форме. Абсолютный путь и выход
 * за корень — ошибка ввода: иначе `refs p:../q/src/a.ts` читает чужое
 * дерево, а места печатает из `p`, то есть отвечает про два дерева
 * сразу под отметкой одного.
 */
function insideRepo(path: string, raw: string): string {
  if (path.startsWith("/")) {
    throw new UsageError(`путь адреса относителен корню репозитория: '${raw}'`);
  }
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      parts.push(segment);
      continue;
    }
    if (parts.length === 0) {
      throw new UsageError(
        `путь адреса выходит за корень репозитория: '${raw}'`,
      );
    }
    parts.pop();
  }
  if (parts.length === 0) {
    throw new UsageError(`в адресе нет пути: '${raw}'`);
  }
  return parts.join("/");
}

/** Хвост из одних цифр — номер строки, а не часть пути. */
const LINE = /^\d+$/;

/**
 * Разбирает адрес. Пустой путь и нулевая строка — ошибки ввода: они
 * не адресуют ничего, и молча превратить их в «весь файл» значило бы
 * ответить не на тот вопрос.
 */
export function parseAddress(raw: string): Address {
  const parts = raw.split(":");
  const line = parts.length > 1 && LINE.test(parts[parts.length - 1])
    ? Number(parts.pop())
    : undefined;
  if (line !== undefined && line < 1) {
    throw new UsageError(`строка адреса не может быть нулевой: '${raw}'`);
  }
  if (parts.length > 2) {
    throw new UsageError(`адрес разобран неоднозначно: '${raw}'`);
  }
  const repo = parts.length === 2 ? parts[0] : undefined;
  const path = parts[parts.length - 1];
  if (path === "") throw new UsageError(`в адресе нет пути: '${raw}'`);
  if (repo === "") {
    throw new UsageError(`в адресе пустое имя репозитория: '${raw}'`);
  }
  return { repo, path: insideRepo(path, raw), line };
}
