/**
 * Путь подключения строки — её канал вызова (`platform/back-rpc.md`,
 * «Строка»): `/line` — клиент с человеком, `/agent/line` — агент, у
 * которого изменить правило нельзя ни при каком ответе.
 */

import { Agent, type Channel, Human, NOBODY } from "../policy/mod.ts";
import type { SocketLine } from "./line.ts";

/** Путь подключения: строит канал строки. */
export interface Door {
  /**
   * @param line строка по сокету: вопрос кадром, ответ кадром
   * @param human есть ли у клиента, кого спросить (поле первого кадра)
   */
  channel(line: SocketLine, human: boolean): Channel;
}

function clientChannel(line: SocketLine, human: boolean): Channel {
  if (!human) return NOBODY;
  return new Human((question) => line.question(question), () => line.answer());
}

/** `/line`: клиент отвечает на вопросы, включая изменение правила. */
export const HUMAN_DOOR: Door = { channel: clientChannel };

/** `/agent/line`: вопрос `ask` — клиенту, изменение правила — никому. */
export const AGENT_DOOR: Door = {
  channel: (line, human) => new Agent(clientChannel(line, human)),
};
