/**
 * Позиция треда строкой (`mr-read.md`, колонка LOCATION): один и тот же
 * текст печатают `comments` (таблица, JSON, markdown) и `show`.
 *
 * Строка отвечает на единственный вопрос оператора: какую строку какого
 * файла обсуждают. Поэтому у позиции только со старой стороной суффикс
 * `(old)` обязателен — без него номер читался бы как номер в новой
 * версии файла, то есть указывал бы не туда.
 */

import type { NotePosition } from "../gitlab/mod.ts";

/** Строка LOCATION; у треда без позиции её нет вовсе. */
export function locationOf(position: NotePosition | null): string | null {
  if (position === null) return null;
  const newPath = position.new_path ?? "";
  const oldPath = position.old_path ?? "";
  if (position.new_line !== null) {
    return `${newPath === "" ? oldPath : newPath}:${position.new_line}`;
  }
  if (position.old_line !== null) {
    return `${oldPath === "" ? newPath : oldPath}:${position.old_line} (old)`;
  }
  // Позиция без номеров (комментарий к файлу целиком) — только путь.
  const path = newPath === "" ? oldPath : newPath;
  return path === "" ? null : path;
}
