/**
 * Разбор ввода `mpu telegram search` (`docs/specs/telegram-search.md`,
 * «CLI-контракт» и «Граничные случаи»): что и где ищем.
 *
 * Модуль чистый: сети здесь нет, поэтому запрещённые сочетания
 * аргументов и диапазон `--limit` отбиваются до открытия сеанса.
 */

import { UsageError } from "../command/mod.ts";
import { inputError } from "./errors.ts";
import { parsePeer, type Peer } from "./peer.ts";

export const LIMIT_MIN = 1;
export const LIMIT_MAX = 500;

/** Адресат вместе со строкой, которой его задал пользователь. */
export interface PeerTarget {
  /** Строка как её задал пользователь: она стоит в отказе резолва. */
  readonly target: string;
  readonly peer: Peer;
}

/** Что и где ищем — весь разобранный ввод вызова. */
export interface SearchPlan {
  /** Текст запроса; пустой означает историю чата и бывает только с `chat`. */
  readonly query: string;
  /** Чат поиска; `null` — поиск по всем диалогам. */
  readonly chat: PeerTarget | null;
  /** Фильтр по отправителю; `null` — без фильтра. */
  readonly from: PeerTarget | null;
  readonly limit: number;
}

/** Аргументы вызова, как их отдала схема команды. */
export interface SearchArgs {
  readonly query: string;
  readonly chat: string;
  readonly from: string;
  readonly limit: string;
}

/** Приводит аргументы к плану поиска; запрещённое сочетание — отказ ввода. */
export function searchPlan(args: SearchArgs): SearchPlan {
  const limit = parseLimit(args.limit);
  const chat = peerTarget(args.chat);
  const from = peerTarget(args.from);
  // Проверка про `--from` идёт первой: без чата и без текста запроса
  // подходят обе, а пользователю нужна та, что называет его флаг.
  if (from !== null && chat === null && args.query === "") {
    throw inputError(
      "--from без --chat требует текст запроса " +
        "(глобальный поиск по отправителю — только с текстом)",
    );
  }
  if (args.query === "" && chat === null) {
    throw inputError(
      "нужен текст запроса или --chat (пустой глобальный поиск запрещён)",
    );
  }
  return { query: args.query, chat, from, limit };
}

/**
 * Адресат из строки флага. Незаданный флаг приходит пустой строкой —
 * это отсутствие фильтра, а не пустой адресат: `TELEGRAM_DEFAULT_CHAT`
 * поиск не читает, у него умолчание «по всем диалогам» (там же).
 */
function peerTarget(raw: string): PeerTarget | null {
  return raw === "" ? null : { target: raw, peer: parsePeer(raw) };
}

/** Число сообщений в выдаче: целое в объявленном диапазоне. */
function parseLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < LIMIT_MIN || value > LIMIT_MAX) {
    throw new UsageError(
      `--limit вне диапазона ${LIMIT_MIN}..${LIMIT_MAX}: ${raw}`,
    );
  }
  return value;
}
