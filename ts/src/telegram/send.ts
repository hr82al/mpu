/**
 * Отправка сообщения от имени личного аккаунта
 * (`docs/specs/telegram-send.md`): порядок шагов сеанса, выбор между
 * текстом и альбомом, приведение результата.
 *
 * Клиент MTProto объявлен узким интерфейсом потребителя (`client.ts`):
 * логика порядка и выбора проверяется без сети, а всё, что знает про
 * протокол, лежит в `session.ts` и в тестах не участвует.
 */

import type {
  Attachment,
  ClientMessage,
  OutgoingDocument,
  PeerRef,
  TelegramClient,
} from "./client.ts";
import { configError, telegramOperation } from "./errors.ts";
import { findChatByTitle } from "./lookup.ts";
import type { Peer, ResolvablePeer } from "./peer.ts";

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
  const peer = plan.peer;
  // Название чата Telegram не резолвит: ему сразу поиск, и только потом
  // резолв найденного идентификатора.
  if (peer.kind === "title") return await byTitle(client, peer.title);
  try {
    return await client.resolve(peer.kind === "guess" ? asName(peer) : peer);
  } catch (err) {
    // Голая строка, похожая на имя: имени такого нет, но чат с таким
    // названием может быть — вторая попытка (`telegram-mtproto.md`,
    // «Резолв адресата»). Вид, объявленный пользователем, второй попытки
    // не получает: он сказал, что это имя.
    if (peer.kind === "guess") return await byTitle(client, peer.name, err);
    throw configError(
      `не удалось найти чат '${plan.target}': ${reason(err)}; ` +
        `попробуй: mpu telegram ls '${plan.target}' и укажи id или @username`,
      { cause: err },
    );
  }
}

/** Адресат по названию: поиск, затем резолв найденного идентификатора. */
async function byTitle(
  client: TelegramClient,
  title: string,
  /** Отказ первой попытки: он не показывается, но и не теряется. */
  cause?: unknown,
): Promise<PeerRef> {
  const found = await findChatByTitle(client, title, "чат", cause);
  // Отказ на найденном идентификаторе — отказ Telegram, а не «чат не
  // найден»: чат мы только что нашли, его id пришёл от сервера.
  return await telegramOperation(() =>
    client.resolve({ kind: "id", id: found.id })
  );
}

/** Догадка об имени — имя для штатного резолва. */
function asName(
  peer: Extract<Peer, { readonly kind: "guess" }>,
): ResolvablePeer {
  return { kind: "name", name: peer.name };
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
  const album = await telegramOperation(async () => {
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
