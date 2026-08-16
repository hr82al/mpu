/**
 * Отправка сообщения от имени личного аккаунта
 * (`docs/specs/telegram-send.md`): порядок шагов сеанса, выбор между
 * текстом и альбомом, приведение результата.
 *
 * Клиент MTProto объявлен здесь узким интерфейсом потребителя: логика
 * порядка и выбора проверяется без сети, а всё, что знает про протокол,
 * лежит в `session.ts` и в тестах не участвует.
 */

import { configError, telegramFailure } from "./errors.ts";
import type { Peer } from "./peer.ts";

/** Файл, уходящий документом без превью; несколько — альбом. */
export interface Attachment {
  /** Имя файла в Telegram: файлы уходят под своими именами. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Адресат, уже опознанный клиентом: содержимое ссылки — дело клиента. */
export interface PeerRef {
  readonly ref: unknown;
}

/** Сообщение, как о нём отчитался клиент. */
export interface ClientMessage {
  readonly id: number;
  /** Чат, куда легло сообщение; Telegram не сообщил — `null`. */
  readonly chatId: number | null;
  /** Время по данным Telegram; не сообщено — `null`. */
  readonly date: Date | null;
}

/** Результат отправки (`SentMessage` глоссария). */
export interface SentMessage {
  readonly id: number;
  readonly chatId: number;
  /** Время отправки, ISO-8601 в UTC; Telegram не сообщил — `null`. */
  readonly date: string | null;
}

/** Что именно и кому отправляется — весь разобранный ввод вызова. */
export interface SendPlan {
  /** Адресат как его задал пользователь: нужен тексту отказа резолва. */
  readonly target: string;
  readonly peer: Peer;
  /** Текст сообщения либо подпись к последнему вложению; пустой — без подписи. */
  readonly text: string;
  /** Размечен ли текст Markdown. */
  readonly markdown: boolean;
  readonly attachments: readonly Attachment[];
}

/** Вложение, уходящее в Telegram: подпись несёт не каждое. */
export interface OutgoingDocument extends Attachment {
  /** Подпись; её несёт последнее вложение, и только при непустом тексте. */
  readonly caption?: string;
}

/**
 * Клиент MTProto глазами отправки. Сеанс приходит сюда уже открытым и
 * знающим собственную учётную запись — без этого адресат `me` не
 * резолвится, а авторизация обязана проверяться до операции
 * (`platform/telegram-mtproto.md`, «Инварианты»).
 */
export interface TelegramClient {
  readonly resolve: (peer: Peer) => Promise<PeerRef>;
  readonly sendText: (
    to: PeerRef,
    text: string,
    markdown: boolean,
  ) => Promise<ClientMessage>;
  /** Альбом одним вызовом: сообщений столько же, сколько вложений. */
  readonly sendDocuments: (
    to: PeerRef,
    documents: readonly OutgoingDocument[],
    markdown: boolean,
  ) => Promise<readonly ClientMessage[]>;
}

/** Отправляет ровно одно сообщение либо ровно один альбом. */
export async function sendMessage(
  client: TelegramClient,
  plan: SendPlan,
): Promise<SentMessage> {
  const to = await resolveTarget(client, plan);
  const sent = await deliver(client, to, plan);
  return {
    id: sent.id,
    chatId: chatIdOf(sent),
    date: sent.date === null ? null : isoUtc(sent.date),
  };
}

/**
 * Резолв адресата — отдельный шаг, и отказ у него свой: отказ операции,
 * случившийся после, не выдаётся за ненайденный чат
 * (`telegram-mtproto.md`, «Известные отклонения»).
 */
async function resolveTarget(
  client: TelegramClient,
  plan: SendPlan,
): Promise<PeerRef> {
  try {
    return await client.resolve(plan.peer);
  } catch (err) {
    throw configError(
      `не удалось найти чат '${plan.target}': ${reason(err)}; ` +
        `попробуй: mpu telegram ls '${plan.target}' и укажи id или @username`,
      { cause: err },
    );
  }
}

/**
 * Одна операция на вызов: текст без вложений — сообщение, вложения —
 * альбом с подписью у последнего, отдельного текстового сообщения рядом
 * с ним не отправляется (`telegram-send.md`, «Ввод/вывод»).
 */
async function deliver(
  client: TelegramClient,
  to: PeerRef,
  plan: SendPlan,
): Promise<ClientMessage> {
  const album = await operation(async () => {
    if (plan.attachments.length === 0) {
      return [await client.sendText(to, plan.text, plan.markdown)];
    }
    return await client.sendDocuments(to, documents(plan), plan.markdown);
  });
  const last = album.at(-1);
  if (last === undefined) {
    throw configError("Telegram не вернул ни одного сообщения");
  }
  return last;
}

/** Обёртка отказа Telegram: одна строка вместо исключения протокола. */
async function operation(
  body: () => Promise<readonly ClientMessage[]>,
): Promise<readonly ClientMessage[]> {
  try {
    return await body();
  } catch (err) {
    throw telegramFailure(err);
  }
}

/**
 * Вложения альбома в порядке флагов. Непустой текст становится подписью
 * последнего из них; пустой означает отправку без подписи, и тогда её
 * не несёт ни одно вложение (`telegram-send.md`, «Ввод/вывод»).
 */
function documents(plan: SendPlan): readonly OutgoingDocument[] {
  const last = plan.attachments.length - 1;
  return plan.attachments.map((attachment, index) =>
    plan.text === "" || index !== last
      ? attachment
      : { ...attachment, caption: plan.text }
  );
}

/**
 * Идентификатор чата из ответа. Его нет — отказ операции: подстановка
 * нуля выдала бы за ответ значение, которого не приходило
 * (`telegram-send.md`, «Известные отклонения»).
 */
function chatIdOf(sent: ClientMessage): number {
  if (sent.chatId === null) {
    throw configError("Telegram не сообщил идентификатор чата");
  }
  return sent.chatId;
}

/** Время до секунд в UTC: `2026-08-16T08:04:09+00:00`. */
function isoUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
