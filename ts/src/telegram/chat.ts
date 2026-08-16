/**
 * Чат в выдаче `mpu telegram ls` (`docs/specs/telegram-ls.md`):
 * маркировка идентификатора и вид чата.
 *
 * Идентификаторы приходят от клиента сырыми, без маркировки вида, а
 * спека обещает: напечатанное значение можно без правки передать
 * адресатом. Это обещание команды, поэтому маркировка живёт здесь.
 */

/** Вид чата в выдаче. */
export type ChatKind = "user" | "bot" | "group" | "channel" | "unknown";

/**
 * Вид чата в протоколе. От `ChatKind` отличается тем, что различает
 * базовую группу и супергруппу: для вывода они обе `group`, а
 * маркируются по-разному.
 */
export type PeerType =
  | "user"
  | "bot"
  | "chat"
  | "supergroup"
  | "channel"
  | "unknown";

/** Чат, как о нём отчитался клиент: идентификатор ещё сырой. */
export interface RawChat {
  readonly peerType: PeerType;
  readonly rawId: number;
  readonly title: string;
  /** Имя пользователя без `@`; у чата без имени — `null`. */
  readonly username: string | null;
}

/** Строка выдачи `ls` (`Dialog` глоссария). */
export interface Dialog {
  readonly id: number;
  readonly title: string;
  readonly kind: ChatKind;
  readonly username: string | null;
}

/** Смещение маркировки каналов и супергрупп в клиентской конвенции. */
const CHANNEL_MARK = 1_000_000_000_000;

/**
 * Идентификатор в клиентской конвенции: канал и супергруппа
 * `−(10¹² + raw)`, базовая группа `−raw`, пользователь и бот — сырой.
 */
export function markedId(peerType: PeerType, rawId: number): number {
  if (peerType === "channel" || peerType === "supergroup") {
    return -(CHANNEL_MARK + rawId);
  }
  return peerType === "chat" ? -rawId : rawId;
}

/** Строка выдачи из ответа клиента. */
export function dialogOf(chat: RawChat): Dialog {
  return {
    id: markedId(chat.peerType, chat.rawId),
    title: chat.title,
    kind: chatKind(chat.peerType),
    username: chat.username,
  };
}

/**
 * Дедуп по идентификатору с сохранением порядка: побеждает первое
 * вхождение. Нужен и выдаче `ls`, и поиску по названию — контакты с
 * каталогом приходят одним ответом, и чат бывает в обоих списках.
 */
export function dedupeById(dialogs: readonly Dialog[]): readonly Dialog[] {
  const seen = new Set<number>();
  return dialogs.filter((dialog) => {
    if (seen.has(dialog.id)) return false;
    seen.add(dialog.id);
    return true;
  });
}

/** Вид для вывода: базовая группа и супергруппа неразличимы. */
function chatKind(peerType: PeerType): ChatKind {
  switch (peerType) {
    case "user":
      return "user";
    case "bot":
      return "bot";
    case "chat":
    case "supergroup":
      return "group";
    case "channel":
      return "channel";
    case "unknown":
      return "unknown";
    default: {
      const never: never = peerType;
      throw new TypeError(`неизвестный вид чата: ${String(never)}`);
    }
  }
}
