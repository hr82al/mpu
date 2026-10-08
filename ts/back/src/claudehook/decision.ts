/**
 * Ответ хука `PermissionRequest` (`claude-hook-permission-request.md`,
 * «Ответ → решение»): решение — одна строка JSON в stdout, без решения —
 * строка в stderr. Код выхода ответу не принадлежит: у строки хука он
 * всегда 0.
 */

import { PERMISSION_REQUEST } from "@mpu/language/frames";
import { DECIDED, type HookReply, type HookSpeech } from "./reply.ts";

/** Решение Claude Code о вызове. */
export type Behavior = "allow" | "deny";

/** Решение: `behavior` и поля сверх него, в порядке спеки. */
export class PermissionDecision implements HookReply {
  readonly #behavior: Behavior;
  readonly #extra: Readonly<Record<string, unknown>>;

  /**
   * @param behavior `allow` или `deny`
   * @param extra `updatedPermissions`, `updatedInput` или `message`
   */
  constructor(behavior: Behavior, extra: Readonly<Record<string, unknown>>) {
    this.#behavior = behavior;
    this.#extra = extra;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: this.#behavior, ...this.#extra },
      },
    };
    speech.stdout(`${JSON.stringify(output)}\n`);
  }
}

/** `allow` без полей: Claude Code исполняет вызов. */
export const ALLOW = new PermissionDecision("allow", {});

/** `deny` без пояснения. */
export const DENY = new PermissionDecision("deny", {});

/** Без решения: Claude Code ждёт ответа в своём терминальном диалоге. */
export class NoDecision implements HookReply {
  readonly #reason: string;

  /** @param reason причина из таблицы спеки */
  constructor(reason: string) {
    this.#reason = reason;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    speech.stderr(PERMISSION_REQUEST.undecided(this.#reason));
  }
}

/** Причина и строка снятия: на вопрос ответили в терминале. */
export const TERMINAL = "решено в терминале";

/** Причина: вышел срок ожидания ядра или строка оборвалась. */
export const EXPIRED = "истёк срок ожидания";
