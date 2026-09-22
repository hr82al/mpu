/**
 * Взгляды на дерево (`platform/ask-door.md`): обычный (`mpu …`) и дверь
 * (`mpu ask …`). Решение правил у строки одно; что с ним делать по этому
 * адресу и как назвать верный адрес — дело взгляда.
 */

import {
  type Doc,
  type Outcome,
  Refusal,
  type Report,
} from "../objects/mod.ts";
import { type Address, CONFIRM, EXECUTE, REDIRECT } from "../policy/mod.ts";

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
    'Строка набирается как без ask: mpu ask sql sl-1 "update …"; перед\n' +
    "исполнением — вопрос человеку. Строку, которой вопрос не нужен, дверь не\n" +
    "исполняет и называет её адрес без ask.",
};

/** Как дерево исполняется с данного адреса. */
export interface View extends Address {
  /** Адресный отказ: где эту строку исполнят. */
  redirect(report: Report): Promise<Outcome>;
  /** Строка, как её получит нынешняя диспетчеризация. */
  executed(argv: readonly string[]): readonly string[];
}

/** Обычный взгляд: исполняет `allow`, строку `ask` отсылает к двери. */
export const NORMAL: View = {
  onAllow: () => EXECUTE,
  onAsk: () => REDIRECT,
  redirect: (report) =>
    Promise.reject(
      new Refusal(
        `требует подтверждения — вызывай ${report.through(ASK_WORD)}`,
      ),
    ),
  executed: (argv) => argv,
};

/** Дверь: спрашивает о строке `ask`, строку `allow` отсылает без входа. */
export const DOOR: View = {
  onAllow: () => REDIRECT,
  onAsk: () => CONFIRM,
  redirect: (report) =>
    Promise.reject(
      new Refusal(`вопроса не требует — вызывай ${report.text()}`),
    ),
  // Первое `ask` в строке — вход: до него стоит разве что `--json`.
  executed: (argv) => {
    const at = argv.indexOf(ASK_WORD);
    return [...argv.slice(0, at), ...argv.slice(at + 1)];
  },
};
