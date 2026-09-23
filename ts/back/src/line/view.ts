/**
 * Взгляды на дерево (`platform/ask-door.md`): обычный (`mpu …`) и дверь
 * (`mpu ask …`). Решение правил у строки одно; что с ним делать по этому
 * адресу и как назвать верный адрес — дело взгляда.
 */

import {
  type Doc,
  type Outcome,
  Refusal,
  throughGate,
} from "../objects/mod.ts";
import {
  type Address,
  CONFIRM,
  EXECUTE,
  REDIRECT,
  type Treatment,
} from "../policy/mod.ts";

/** Слово входа двери. */
export const ASK_WORD = "ask";

/** Назначение и справка двери. */
export const ASK_DOC: Doc = {
  purpose: "строки, которые спрашивают подтверждение человека",
  help:
    "Звать, когда нужна команда, которая пишет или трогает чужое: под ask\n" +
    "лежат ровно те строки, на которые правила сейчас требуют «да» человека.\n" +
    "Список живой — его меняют правила (mpu ask: / mpu allow: в терминале или\n" +
    "в web), грепом по коду его не получить.\n\n" +
    "Строка набирается как без ask: mpu ask sql target: sl-1 sql: " +
    '"update …";\nперед исполнением — вопрос человеку. Строку, которой вопрос ' +
    "не нужен,\nдверь исполняет без вопроса, как без ask.",
};

/** Как дерево исполняется с данного адреса. */
export interface View extends Address {
  /** Строка, как её получит нынешняя диспетчеризация. */
  executed(argv: readonly string[]): readonly string[];
}

/**
 * Адресный отказ строке `ask`, набранной без двери: где её исполнят.
 * Переадресует только обычный взгляд — дверь исполняет и `allow`.
 */
export function toDoor(): Promise<Outcome> {
  return Promise.reject(
    new Refusal(NEEDS_DOOR, {
      reason: NEEDS_DOOR,
      remedy: throughGate(" — вызывай ", ASK_WORD),
    }),
  );
}

/** Вид отказа: строке нужен ответ человека, а набрана она без двери. */
const NEEDS_DOOR = "требует подтверждения";

/**
 * Строка `allow` через дверь: исполняется без вопроса, как без `ask`
 * (`platform/ask-door.md`, с порции 158), но состав двери не пополняет —
 * под `ask` перечислены строки, которым нужен ответ человека.
 */
const QUIETLY: Treatment = {
  settle: (execution, channel, won) => EXECUTE.settle(execution, channel, won),
  admits: () => false,
};

/** Обычный взгляд: исполняет `allow`, строку `ask` отсылает к двери. */
export const NORMAL: View = {
  onAllow: () => EXECUTE,
  onAsk: () => REDIRECT,
  executed: (argv) => argv,
};

/** Дверь: спрашивает о строке `ask`, строку `allow` исполняет молча. */
export const DOOR: View = {
  onAllow: () => QUIETLY,
  onAsk: () => CONFIRM,
  // Первое `ask` в строке — вход: до него стоит разве что `--json`.
  executed: (argv) => {
    const at = argv.indexOf(ASK_WORD);
    return [...argv.slice(0, at), ...argv.slice(at + 1)];
  },
};
