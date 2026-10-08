/**
 * Ответ хука `PreToolUse` (`claude-hook-pre-tool-use.md`, «Вывод»):
 * решение — JSON в stdout, без решения — строка в stderr. Код выхода
 * ответу не принадлежит: у строки хука он всегда 0.
 */

import { PRE_TOOL_USE } from "@mpu/language/frames";

/** Куда ответ печатает себя: stdout — решение, stderr — его отсутствие. */
export interface HookSpeech {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Ответ хука: печатает себя сам и называет код выхода строки. */
export interface HookReply {
  tell(speech: HookSpeech): void;
  /** Код выхода строки хука: решение и «без решения» — 0. */
  code(): number;
}

/** Код ответов, у которых отказа не бывает: Claude Code решает сам. */
export const DECIDED = (): number => 0;

/** Решение Claude Code одной строкой JSON; порядок ключей — как в спеке. */
function decision(word: string, reason: string): string {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: word,
      permissionDecisionReason: reason,
    },
  };
  return `${JSON.stringify(output)}\n`;
}

/** `allow`: Claude Code исполняет вызов без своего вопроса. */
export class Allowed implements HookReply {
  readonly #reason: string;

  /** @param reason `mpu <путь>: разрешено правилом «<путь правила>»` */
  constructor(reason: string) {
    this.#reason = reason;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    speech.stdout(decision("allow", this.#reason));
  }
}

/** `deny`: Claude Code отказывает в вызове. */
export class Denied implements HookReply {
  readonly #reason: string;

  /** @param reason текст отказа правил: `mpu <путь>: запрещено правилом «…»` */
  constructor(reason: string) {
    this.#reason = reason;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    speech.stdout(decision("deny", this.#reason));
  }
}

/** Без решения: Claude Code проверяет вызов как обычно. */
export class Undecided implements HookReply {
  readonly #reason: string;

  /** @param reason причина из закрытого списка спеки, без значений строки */
  constructor(reason: string) {
    this.#reason = reason;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    speech.stderr(PRE_TOOL_USE.undecided(this.#reason));
  }
}

/** Причина: решение правил `ask`; `won` — путь правила, корень — `*`. */
export function askedBy(won: string): string {
  return `правило «${won}» — ask`;
}

/** Причина: строку решает не правило, а человек (`ownerOnly`). */
export const HUMAN_DECIDES = "решает только человек";

/** Причина: строка меняет правила. */
export const RULE_CHANGE = "изменение правил";

/** Причина: что исполнится, выяснится только при исполнении. */
export const AT_EXECUTION = "решается при исполнении";

const AT_EXECUTION_REPLY = new Undecided(AT_EXECUTION);

/**
 * Ответ строке, чей исход виден только при исполнении: строка хука,
 * значение-выражение, ввод строки без слов. Ответ без памяти — один на
 * модуль.
 */
export function atExecution(): Promise<HookReply> {
  return Promise.resolve(AT_EXECUTION_REPLY);
}

/** Причина: строка кончилась, правил не спросив (справка, `it`). */
export const NOT_RULED = "правила строку не решают";

/** Причина: вызов — не строка `mpu`. */
export const NOT_MPU = "не вызов mpu";

/** Причина: отказ строки при обходе; `reason` — вид отказа. */
export function unparsedLine(reason: string): string {
  return `строка не разобрана: ${reason}`;
}

/** Причина: payload не тот, что ждёт хук. */
export function unparsedInput(what: string): string {
  return `вход не разобран: ${what}`;
}
