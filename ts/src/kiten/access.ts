/**
 * Общее для всех команд семейства `mpu kiten`: как достаётся доступ к
 * Kaiten, во что превращается его отказ и как из пути получается имя
 * файла для загрузки. Всё это одинаково у каждой команды семейства
 * (`platform/kaiten-http.md`), и копия на команду значила бы столько же
 * мест правки при изменении класса ошибки или текста подсказки.
 */

import { type CommandIo, DomainError, UsageError } from "../command/mod.ts";
import {
  type KaitenAccess,
  KaitenError,
  requireKaitenAccess,
} from "../kaiten/mod.ts";

/**
 * Доступ к Kaiten. Ненастроенный ключ — ошибка ВВОДА (exit 2) с подсказкой,
 * а не отказ API: сети команда ещё не касалась (`platform/kaiten-http.md`,
 * «Конфигурация»). Каталог различить эти два случая не может — оба приходят
 * одним классом, — поэтому различает вызывающий, по месту вызова.
 */
export function kaitenAccess(io: CommandIo): KaitenAccess {
  try {
    return requireKaitenAccess(io.envFile);
  } catch (err) {
    if (!(err instanceof KaitenError)) throw err;
    throw new UsageError(err.message, {
      hint: "добавить KITEN_API_KEY в env-файл",
      cause: err,
    });
  }
}

/** Отказ Kaiten — доменная ошибка команды: exit 1 и текст в stderr. */
export function asCommandError(err: unknown): unknown {
  return err instanceof KaitenError
    ? new DomainError(`kaiten error: ${err.message}`, { cause: err })
    : err;
}

/**
 * Имя файла без каталога — оно и уходит в Kaiten именем вложения
 * (`kiten-comment.md`) либо артефакта (`kiten-field.md`). Свой разбор, а
 * не зависимость: путь приходит из argv POSIX-машины, и правило «после
 * последнего `/`» — всё, что нужно.
 */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
