/**
 * Общее для всех команд семейства `mpu kiten`: как достаётся доступ к
 * Kaiten, во что превращается его отказ, как собирается адрес карточки
 * для человека и как из пути получается имя файла для загрузки. Всё это
 * одинаково у каждой команды семейства
 * (`platform/kaiten-http.md`), и копия на команду значила бы столько же
 * мест правки при изменении класса ошибки или текста подсказки.
 */

import { type CommandIo, DomainError, UsageError } from "../command/mod.ts";
import {
  type KaitenAccess,
  KaitenError,
  requireKaitenAccess,
} from "../kaiten/mod.ts";

/** Срез порта исполнения: ключ доступа берётся из env-файла. */
export type AccessIo = Pick<CommandIo, "envFile">;

/**
 * Доступ к Kaiten. Ненастроенный ключ — ошибка ВВОДА (exit 2) с подсказкой,
 * а не отказ API: сети команда ещё не касалась (`platform/kaiten-http.md`,
 * «Конфигурация»). Каталог различить эти два случая не может — оба приходят
 * одним классом, — поэтому различает вызывающий, по месту вызова.
 */
export function kaitenAccess(io: AccessIo): KaitenAccess {
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
 * Тот же отказ, но на названном шаге команды-оркестратора: маркер шага
 * входит в текст, чтобы по сообщению было видно, докуда команда дошла и
 * что уже применено (`kiten-close.md`, «Ввод/вывод»).
 */
export function asStepError(step: string, err: unknown): unknown {
  return err instanceof KaitenError
    ? new DomainError(`kaiten error (${step}): ${err.message}`, { cause: err })
    : err;
}

/** Адрес карточки для человека: базовый URL API и id, не ответ сервера. */
export function cardUrl(access: KaitenAccess, cardId: number): string {
  return `${access.baseUrl}/${cardId}`;
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
