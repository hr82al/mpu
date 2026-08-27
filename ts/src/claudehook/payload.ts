/**
 * Разбор payload'а хука Claude Code и сборка текста уведомления
 * (`docs/specs/claude-hook-notification.md`).
 *
 * Разбор терпимый: незнакомые поля игнорируются, отсутствующие и поля
 * не того типа считаются незаданными. Причина — уведомление важнее
 * строгости: состав payload'а меняется вместе с Claude Code, а хук
 * зовут ровно тогда, когда сессия ждёт человека.
 *
 * Конверт (`parseHookPayload`) отделён от того, что специфично для
 * события `Notification` (`notificationText`): следующим сюда придёт
 * второе событие того же хука, и дёшево должно стать именно оно.
 */

import { UsageError } from "../command/mod.ts";

/**
 * Предел длины текста `sendMessage` у Bot API. Единица счёта —
 * кодовые единицы UTF-16 (`string.length`), как у подписи в
 * `telegram log`: чем меряет сам Telegram, не проверено, а UTF-16 —
 * граница консервативная.
 */
export const TEXT_LIMIT = 4096;

/**
 * Конверт хука: сам объект payload'а и поля, общие всем его событиям.
 * Поля читаются лениво (`stringField`), а не раскладываются в
 * именованные: событий у хука много, и чужие поля конверту не нужны.
 */
export interface HookPayload {
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Разбирает stdin хука. Требование ровно одно — это JSON-объект: без
 * него читать нечего, и отказ обязан случиться до сети.
 *
 * Содержимое stdin в текст отказа не попадает ни куском, ни первой
 * строкой: секция `err` записи журнала вернула бы его на диск
 * (`platform/invoke-log.md`).
 */
export function parseHookPayload(text: string): HookPayload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Ошибка `JSON.parse` не переносится в `cause`: её текст цитирует
    // вход, а тому нельзя оказаться ни в одной поверхности вывода
    // (инвариант спеки). Причина здесь ровно одна, и она в тексте.
    throw badPayload();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badPayload();
  }
  // Сужение до объекта сделано проверками строкой выше; индексная
  // сигнатура из `object` не выводится, отсюда приведение.
  return { fields: value as Readonly<Record<string, unknown>> };
}

function badPayload(): UsageError {
  return new UsageError("stdin хука разбирается как JSON-объект");
}

/**
 * Текст уведомления: заголовок и — при непустом `notification_message`
 * — само сообщение второй строкой.
 *
 * `session_id`, `permission_mode`, `transcript_path` и
 * `notification_data` в текст не идут: на телефоне они бесполезны или
 * непредсказуемы по форме.
 */
export function notificationText(payload: HookPayload): string {
  const head = ["Claude", projectName(payload), eventType(payload)]
    .filter((part) => part !== "")
    .join(" · ");
  const message = stringField(payload, "notification_message");
  return fitLimit(message === "" ? head : `${head}\n${message}`);
}

/** Тип события; поля нет — общее слово: сам факт события уже сигнал. */
function eventType(payload: HookPayload): string {
  const type = stringField(payload, "notification_type");
  return type === "" ? "notification" : type;
}

/**
 * Проект — базовое имя каталога сессии. Завершающие слэши снимаются:
 * иначе `/…/mpu/` дал бы пустую часть заголовка.
 */
function projectName(payload: HookPayload): string {
  const cwd = stringField(payload, "cwd").replace(/\/+$/, "");
  return cwd.slice(cwd.lastIndexOf("/") + 1);
}

/** Строковое поле payload'а; поля нет либо оно не строка — пустая. */
function stringField(payload: HookPayload, name: string): string {
  const value = payload.fields[name];
  return typeof value === "string" ? value : "";
}

/**
 * Усечение вместо отказа: отказ здесь не видит никто (Claude
 * игнорирует у хука всё, включая код выхода), а усечённое уведомление
 * доходит. Многоточие входит в предел, а не добавляется сверх него, —
 * иначе Telegram отбил бы ровно тот вызов, который усечение спасало.
 */
function fitLimit(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  const cut = TEXT_LIMIT - 1;
  // Суррогатная пара режется целиком: половина пары символом не
  // является и уехала бы в Telegram мусором вида `\ud83d`.
  const end = isHighSurrogate(text.charCodeAt(cut - 1)) ? cut - 1 : cut;
  return `${text.slice(0, end)}…`;
}

/** Старшая половина суррогатной пары: за ней обязана идти младшая. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
