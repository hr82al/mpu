/**
 * Маршрут набранной строки: каким путём ядро её поведёт — строка хука,
 * строка образа или обычная цепочка. Выбирается здесь, в одном месте; хук
 * спрашивает этот же маршрут (`claude-hook-pre-tool-use.md`, «Как
 * находится решение»).
 */

import { type ImageLine, imageLineOf } from "./define.ts";
import { hookLineOf, type HookPorts } from "./hook.ts";
import { syncLineOf } from "./sync.ts";

/**
 * Маршрут по словам строки без входа двери: особые строки — хука и
 * образа; не особая — `otherwise` у `settle` и `consult`, обычная цепочка.
 */
export function routeOf(said: readonly string[], hook: HookPorts): ImageLine {
  return hookLineOf(said, hook, imageLineOf(said, syncLineOf(said)));
}
