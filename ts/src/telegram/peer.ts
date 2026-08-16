/**
 * Приведение строки пользователя к адресату Telegram
 * (`docs/specs/platform/telegram-mtproto.md`, «Резолв адресата»).
 *
 * Функция чистая: сеть в приведении не участвует, поэтому ошибка ввода
 * видна до открытия сеанса.
 */

import { inputError } from "./errors.ts";

/** Текст отказа общий с незаданным адресатом: действие одно и то же. */
export const EMPTY_TARGET =
  "адресат не задан; укажи --chat или TELEGRAM_DEFAULT_CHAT в .env";

/** Адресат операции после приведения строки пользователя. */
export type Peer =
  /** «Избранное» — собственный чат; резолвится после того, как сеанс узнал себя. */
  | { readonly kind: "me" }
  /** Числовой id в клиентской конвенции (маркированный). */
  | { readonly kind: "id"; readonly id: number }
  /**
   * Вид объявлен пользователем («@», ссылка `t.me`): Telegram резолвит
   * такую строку сам, и второй попытки у неё нет.
   */
  | { readonly kind: "name"; readonly name: string }
  /**
   * Голая строка, похожая на имя пользователя или телефон: сперва
   * штатный резолв, при его неудаче — поиск по названию
   * (`platform/telegram-mtproto.md`, «Резолв адресата»: две попытки).
   */
  | { readonly kind: "guess"; readonly name: string }
  /**
   * Название чата: Telegram по нему не резолвит, нужен поиск
   * (`docs/specs/telegram-ls.md`, «Резолв по названию»).
   */
  | { readonly kind: "title"; readonly title: string };

/**
 * Адресат, который Telegram резолвит сам. Название чата сюда не входит:
 * по нему сперва идёт поиск (`docs/specs/telegram-ls.md`).
 */
export type ResolvablePeer = Extract<
  Peer,
  { readonly kind: "me" | "id" | "name" }
>;

const LINK = /^(?:https?:\/\/)?t\.me\/(.*)$/i;

/**
 * Имя пользователя Telegram: латиница, цифры и подчёркивание, начиная с
 * буквы. Строка, не подходящая под это и не являющаяся телефоном или
 * id, — название чата, и её ищут поиском.
 */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/** Телефон: только цифры с обязательным «+» — иначе это числовой id. */
const PHONE = /^\+\d{5,15}$/;

/** Приводит строку пользователя к адресату; строка непустая. */
export function parsePeer(target: string): Peer {
  const tail = linkTail(target);
  const declared = tail.startsWith("@") || tail !== target;
  const name = tail.startsWith("@") ? tail.slice(1) : tail;
  // От адресата остались одни знаки объявления («@», «t.me/»): резолвить
  // нечего, и это ошибка ввода, а не пустой поиск.
  if (name === "") throw inputError(EMPTY_TARGET);
  if (name === "me") return { kind: "me" };
  const id = Number(name);
  // Цифры длиннее безопасного целого — не id: округление увело бы
  // сообщение в чужой чат. Такая строка уходит именем, и отказ придёт
  // от резолва, с положенным ему текстом.
  if (/^-?\d+$/.test(name) && Number.isSafeInteger(id)) {
    return { kind: "id", id };
  }
  // Ведущий «@» и ссылка `t.me` — объявление пользователя, а не
  // названия: такую строку резолвит сам Telegram, даже если она не
  // похожа на обычное имя (приглашение `t.me/+AbCdEf`), и поиском её
  // добирать не за чем — вид назвал сам пользователь.
  if (declared) return { kind: "name", name };
  // Голая строка, похожая на имя: имя такое может и не существовать, а
  // чат с таким названием — вполне («news», «team»). Отсюда две попытки.
  if (USERNAME.test(name) || PHONE.test(name)) return { kind: "guess", name };
  // Прочее — название чата, уже нормализованное: поиск и текст отказа
  // берут его отсюда, а не сырую строку.
  return { kind: "title", title: name };
}

/**
 * Хвост ссылки `t.me` без крайних «/»; ссылки нет или хвост пуст —
 * строка берётся целиком: «t.me/» пустым именем не становится, а уходит
 * названием, как любая строка, которую Telegram не резолвит сам.
 */
function linkTail(target: string): string {
  const match = LINK.exec(target);
  if (match === null) return target;
  const tail = match[1].replace(/^\/+|\/+$/g, "");
  return tail === "" ? target : tail;
}
