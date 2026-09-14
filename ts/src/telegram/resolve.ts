/**
 * Резолв адресата (`docs/specs/platform/telegram-mtproto.md`, «Резолв
 * адресата»): две попытки — штатный резолв клиентом, а при его неудаче
 * поиск чата по названию.
 *
 * Живёт отдельно от отправки: адресата приводят и `send`, и фильтры
 * поиска (`docs/specs/telegram-search.md`, `--chat` и `--from`), а
 * предмет отказа у них разный — его называет `subject`.
 */

import { VerbatimError } from "../command/mod.ts";
import type { PeerRef } from "./client.ts";
import { configError } from "./errors.ts";
import { type ChatSearch, findChatByTitle } from "./lookup.ts";
import type { Peer, ResolvablePeer } from "./peer.ts";

/** Что нужно резолву от клиента: штатный резолв и поиск по названию. */
export interface PeerResolver extends ChatSearch {
  readonly resolve: (peer: ResolvablePeer) => Promise<PeerRef>;
}

/**
 * Приводит разобранный адресат к ссылке клиента. `target` — строка, как
 * её задал пользователь: она стоит в отказе. `subject` называет предмет
 * отказа: «чат» для адресата, «отправителя» для фильтра по автору.
 */
export async function resolveTarget(
  client: PeerResolver,
  target: string,
  peer: Peer,
  subject: string,
): Promise<PeerRef> {
  // Название чата Telegram не резолвит: ему сразу поиск, и только потом
  // резолв найденного идентификатора.
  if (peer.kind === "title") return await byTitle(client, peer.title, subject);
  try {
    return await client.resolve(peer.kind === "guess" ? asName(peer) : peer);
  } catch (err) {
    // Неудача резолва — только отказ клиента, уже оформленный портом
    // сеанса; дефект своего кода уходит как есть и за «не найден» себя не
    // выдаёт (спека, «Что считается отказом Telegram / слоя клиента»).
    if (!(err instanceof VerbatimError)) throw err;
    const refusal = clientOrigin(err);
    // Голая строка, похожая на имя: имени такого нет, но чат с таким
    // названием может быть — вторая попытка (`telegram-mtproto.md`,
    // «Резолв адресата»). Вид, объявленный пользователем, второй попытки
    // не получает: он сказал, что это имя или телефон.
    if (peer.kind === "guess") {
      return await byTitle(client, peer.name, subject, refusal);
    }
    throw configError(
      `не удалось найти ${subject} '${target}': ${reason(refusal)}; ` +
        `попробуй: mpu telegram ls '${target}' и укажи id или @username`,
      { cause: refusal },
    );
  }
}

/**
 * Исходный отказ клиента под строкой слоя: причина «не удалось найти»
 * называется его текстом, а не строкой `telegram: …` второй раз. Строка
 * слоя без причины (своё оформление) — сама себе исходный отказ.
 */
function clientOrigin(err: VerbatimError): unknown {
  return err.cause ?? err;
}

/** Адресат по названию: поиск, затем резолв найденного идентификатора. */
async function byTitle(
  client: PeerResolver,
  title: string,
  subject: string,
  /** Отказ первой попытки: он не показывается, но и не теряется. */
  cause?: unknown,
): Promise<PeerRef> {
  const found = await findChatByTitle(client, title, subject, cause);
  // Отказ на найденном идентификаторе уходит как есть — отказом клиента,
  // а не «чат не найден»: чат мы только что нашли, его id пришёл от сервера.
  return await client.resolve({ kind: "id", id: found.id });
}

/** Догадка об имени — имя для штатного резолва. */
function asName(
  peer: Extract<Peer, { readonly kind: "guess" }>,
): ResolvablePeer {
  return { kind: "name", name: peer.name };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
