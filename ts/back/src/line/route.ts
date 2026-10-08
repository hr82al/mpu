/**
 * Маршрут набранной строки: каким путём ядро её поведёт — строка хука,
 * строка образа, программа или обычная цепочка. Выбирается здесь, в
 * одном месте; хук спрашивает этот же маршрут
 * (`claude-hook-pre-tool-use.md`, «Как находится решение»).
 */

import { atExecution, type HookReply } from "../claudehook/mod.ts";
import type { ImageMethod } from "../image/mod.ts";
import { type Commands, isProgram } from "@mpu/language/program";
import { type ImageContext, imageLineOf } from "./define.ts";
import { hookLineOf, type HookPorts } from "./hook.ts";
import { callsImage } from "./methods.ts";
import { syncLineOf } from "./sync.ts";

/** Чем ядро исполняет строку, которую не ведёт особый маршрут. */
export interface LineWays {
  /** Обычная цепочка по дереву. */
  chain(): Promise<number>;
  /** Программа: разбор, обход правилами, исполнитель программ. */
  program(): Promise<number>;
}

/** Маршрут строки. */
export interface Route {
  /** Исполнить строку этим маршрутом. */
  settle(context: ImageContext, ways: LineWays): Promise<number>;
  /**
   * Ответ хука `PreToolUse` на строку этого маршрута, ничего не
   * исполняя; обычную цепочку решает проба `probe`.
   */
  consult(probe: () => Promise<HookReply>): Promise<HookReply>;
}

/** Что нужно выбору маршрута: дерево, методы образа, порты хука. */
export interface RouteParts {
  /** Дерево команд с методами образа — для «программа ли». */
  readonly commands: Commands;
  readonly methods: readonly ImageMethod[];
  readonly hook: HookPorts;
}

/** Программа: слова — выражение или вызов метода образа. */
const PROGRAM: Route = {
  settle: (_context, ways) => ways.program(),
  consult: atExecution,
};

/** Обычная цепочка. */
const CHAIN: Route = {
  settle: (_context, ways) => ways.chain(),
  consult: (probe) => probe(),
};

/**
 * Маршрут по словам строки без входа двери: особые строки — хука и
 * образа, — затем программа, иначе цепочка.
 */
export function routeOf(said: readonly string[], parts: RouteParts): Route {
  const special = hookLineOf(
    said,
    parts.hook,
    imageLineOf(said, syncLineOf(said)),
  );
  // Программа ли — только если особый маршрут строку не взял.
  const plain = () =>
    isProgram(said, parts.commands) || callsImage(said, parts.methods)
      ? PROGRAM
      : CHAIN;
  return {
    settle: (context, ways) =>
      special.settle(context, () => plain().settle(context, ways)),
    consult: (probe) => special.consult(() => plain().consult(probe)),
  };
}
