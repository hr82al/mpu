/**
 * Строка хука `PreToolUse` (`claude-hook-pre-tool-use.md`, «Клиент»): её
 * слова и строка «без решения». Лежат в контракте кадров, потому что у
 * них две стороны: ядро печатает причины, клиент — «правила недоступны»,
 * когда ядро до решения не дошло. Текст один на обе.
 */

/** Слова строки хука: по ним ядро и клиент узнают её. */
export const HOOK_WORDS: readonly string[] = ["claude-hook", "pre-tool-use"];

/**
 * Строка «без решения» для stderr: Claude Code проверит вызов как обычно.
 *
 * @param reason причина — постоянная строка, без значений ключей строки
 */
export function undecidedLine(reason: string): string {
  return `mpu ${HOOK_WORDS.join(" ")}: без решения — ${reason}\n`;
}

/** Причина «правила недоступны»: ядро не ответило решением. */
export function unavailable(cause: string): string {
  return `правила недоступны: ${cause}`;
}
