/**
 * Путь подключения строки — её канал вызова (`platform/back-rpc.md`,
 * «Строка»): `/line` — клиент с человеком, `/agent/line` — агент, у
 * которого изменить правило нельзя ни при каком ответе.
 */

import { Agent, type Channel, Human, NOBODY } from "../policy/mod.ts";
import type { RootMethod } from "../line/mod.ts";
import {
  FileOutlet,
  type Outlet,
  type Run,
  type Spill,
  WHOLE,
} from "./outlet.ts";
import { NO_RIVAL, type Rival } from "./line.ts";
import type { Asking, PromptDoor } from "./prompt.ts";
import type { WebAccess } from "./web.ts";

/** Путь подключения: строит канал строки. */
export interface Door {
  /**
   * @param line вопрос строки и ответ на него
   * @param human есть ли у клиента, кого спросить (поле первого кадра)
   */
  channel(line: Questions, human: boolean): Channel;
  /**
   * Что проходит по двери, когда спрашивает сама команда
   * (`platform/line-prompt.md`): какие виды вопроса и предлагается ли
   * копирование.
   *
   * @param human есть ли у клиента, кого спросить
   */
  prompting(human: boolean): PromptDoor;
  /** Методы корня, которые есть только у этой двери. */
  rootMethods(services: DoorServices): readonly RootMethod[];
  /** Канал автора определения метода образа (`platform/image.md`). */
  readonly author: string;
  /**
   * Голова вопроса-подтверждения в чате владельца
   * (`platform/ask-telegram.md`, «Вопрос в чате»).
   */
  readonly confirmHead: string;
  /**
   * Второй адресат вопроса, заданного номером (`platform/ask-telegram.md`
   * [D.1]): есть, только если клиент двери забирает решение в другом месте
   * сам (`POST …/settled`).
   */
  ticketRival(rival: Rival): Rival;
  /**
   * Как собранный ответ отдаст вывод прогона `run`
   * (`platform/long-output.md`, §4).
   */
  outlet(spill: Spill, run: Run): Outlet;
}

/** Чем канал правил спрашивает строку. */
export type Questions = Pick<Asking, "question" | "answer">;

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
        help: "Гасит все сессии и ключи входа в браузере; ответ — число сессий.",
      },
      produce: () => services.web.logout(),
    },
  ];
}

function clientChannel(line: Questions, human: boolean): Channel {
  if (!human) return NOBODY;
  return new Human(
    (question) => line.question(question, "line"),
    () => line.answer(),
  );
}

/** Дверь человека: спрашивает оба вида и предлагает копирование. */
const HUMAN_PROMPTS: PromptDoor = {
  asks: () => true,
  copies: () => true,
};

/**
 * Дверь агента: скрытый ввод не задаётся никогда, даже с `human: true`
 * (`platform/line-prompt.md`) — ответ прошёл бы через переписку клиента
 * агента и осел в его истории. Копирование ему не предлагается: буфера
 * обмена у агента нет.
 */
const AGENT_PROMPTS: PromptDoor = {
  asks: (kind) => kind === "line",
  copies: () => false,
};

/** Спросить некого: клиент пришёл без человека. */
const NO_PROMPTS: PromptDoor = {
  asks: () => false,
  copies: () => false,
};

/** `/line`: клиент отвечает на вопросы, включая изменение правила. */
export const HUMAN_DOOR: Door = {
  channel: clientChannel,
  prompting: (human) => (human ? HUMAN_PROMPTS : NO_PROMPTS),
  rootMethods: webMethods,
  author: "human",
  confirmHead: "❓ mpu ask",
  // Номером на этой двери спрашивают страница `web/` и `curl`: о решении в
  // чате они не узнают, и снять их вопрос нечем — чат его не получает.
  ticketRival: () => NO_RIVAL,
  // У человека терминал: большой вывод он направит сам.
  outlet: () => WHOLE,
};

/** `/agent/line`: вопрос `ask` — клиенту, изменение правила — никому. */
export const AGENT_DOOR: Door = {
  channel: (line, human) => new Agent(clientChannel(line, human)),
  prompting: (human) => (human ? AGENT_PROMPTS : NO_PROMPTS),
  rootMethods: () => [],
  author: "agent",
  confirmHead: "❓ mpu ask (MCP)",
  // Переводчик MCP ждёт решения запросом `…/settled` и снимает форму сам.
  ticketRival: (rival) => rival,
  // Ответ агенту целиком — в его контекст: большой уходит файлом.
  outlet: (spill, run) => new FileOutlet(spill, run),
};
