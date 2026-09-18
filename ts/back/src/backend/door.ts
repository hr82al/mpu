/**
 * Путь подключения строки — её канал вызова (`platform/back-rpc.md`,
 * «Строка»): `/line` — клиент с человеком, `/agent/line` — агент, у
 * которого изменить правило нельзя ни при каком ответе.
 */

import { Agent, type Channel, Human, NOBODY } from "../policy/mod.ts";
import type { RootMethod } from "../next/mod.ts";
import type { Line } from "./line.ts";
import type { WebAccess } from "./web.ts";

/** Путь подключения: строит канал строки. */
export interface Door {
  /**
   * @param line строка по сокету: вопрос кадром, ответ кадром
   * @param human есть ли у клиента, кого спросить (поле первого кадра)
   */
  channel(line: Line, human: boolean): Channel;
  /** Методы корня, которые есть только у этой двери. */
  rootMethods(services: DoorServices): readonly RootMethod[];
}

/** Что сервер даёт методам двери. */
export interface DoorServices {
  readonly web: WebAccess;
  /** Адрес страницы фронта: `http://mpu.localhost:<порт>`. */
  readonly origin: string;
}

/** Вход в браузере — только у двери человека (`specs/web.md`). */
function webMethods(services: DoorServices): readonly RootMethod[] {
  return [
    {
      selector: "web",
      doc: {
        purpose: "ссылка входа в браузере",
        help:
          "Одноразовая ссылка на страницу mpu в браузере: ключ живёт 60 секунд.\n" +
          "Только у человека: агенту метод недоступен.",
      },
      produce: () =>
        Promise.resolve(`${services.origin}/?key=${services.web.issueKey()}\n`),
    },
    {
      selector: "web-logout",
      doc: {
        purpose: "погасить сессии браузера",
        help:
          "Гасит все сессии и ключи входа в браузере; ответ — число сессий.",
      },
      produce: () => services.web.logout(),
    },
  ];
}

function clientChannel(line: Line, human: boolean): Channel {
  if (!human) return NOBODY;
  return new Human((question) => line.question(question), () => line.answer());
}

/** `/line`: клиент отвечает на вопросы, включая изменение правила. */
export const HUMAN_DOOR: Door = {
  channel: clientChannel,
  rootMethods: webMethods,
};

/** `/agent/line`: вопрос `ask` — клиенту, изменение правила — никому. */
export const AGENT_DOOR: Door = {
  channel: (line, human) => new Agent(clientChannel(line, human)),
  rootMethods: () => [],
};
