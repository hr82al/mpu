/**
 * Приведение строки пользователя к адресату Telegram
 * (`docs/specs/platform/telegram-mtproto.md`, «Резолв адресата»).
 *
 * Функция чистая: сеть в приведении не участвует, поэтому ошибка ввода
 * видна до открытия сеанса.
 */

/** Адресат операции после приведения строки пользователя. */
export type Peer =
  /** «Избранное» — собственный чат; резолвится после того, как сеанс узнал себя. */
  | { readonly kind: "me" }
  /** Числовой id в клиентской конвенции (маркированный). */
  | { readonly kind: "id"; readonly id: number }
  /** Имя пользователя, телефон или иная строка, понятная Telegram. */
  | { readonly kind: "name"; readonly name: string };

const LINK = /^(?:https?:\/\/)?t\.me\/(.*)$/i;

/** Приводит строку пользователя к адресату; строка непустая. */
export function parsePeer(target: string): Peer {
  const tail = linkTail(target);
  const name = tail.startsWith("@") ? tail.slice(1) : tail;
  if (name === "me") return { kind: "me" };
  const id = Number(name);
  // Цифры длиннее безопасного целого — не id: округление увело бы
  // сообщение в чужой чат. Такая строка уходит именем, и отказ придёт
  // от резолва, с положенным ему текстом.
  if (/^-?\d+$/.test(name) && Number.isSafeInteger(id)) {
    return { kind: "id", id };
  }
  return { kind: "name", name };
}

/**
 * Хвост ссылки `t.me` без крайних «/»; ссылки нет или хвост пуст —
 * строка берётся целиком: «t.me/» адресатом не является и должен дойти
 * до Telegram как есть, а не превратиться в пустое имя.
 */
function linkTail(target: string): string {
  const match = LINK.exec(target);
  if (match === null) return target;
  const tail = match[1].replace(/^\/+|\/+$/g, "");
  return tail === "" ? target : tail;
}
