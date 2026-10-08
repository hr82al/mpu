/**
 * Ход проекта глазами оркестратора (`task-orchestrator.md`, «Шаг
 * проекта»): кому что сказать, остановлен ли проект и о чём уведомить.
 * Всё выводится из журнала; ничего не хранится.
 */

import {
  ANSWER,
  type Kind,
  OWNER,
  OWNER_ANSWER,
  QUESTION,
  REPORT,
  STOP,
  TASK,
  type Turn,
} from "../kind.ts";
import type { Message } from "../project.ts";

/** Час: после него занятость без движения и вопрос владельцу — событие. */
export const HOUR_MS = 60 * 60 * 1000;

/** Что роли делать сейчас: строка раздела первого сообщения. */
export interface Move {
  /** Есть ли повод будить роль. */
  readonly due: boolean;
  line(): string;
}

/** Событие уведомления: ключ — чтобы повтор был молчаливым. */
export interface Event {
  readonly key: string;
  readonly text: string;
}

/** Повода нет: роль ждёт своего вида сообщения. */
function idle(project: string, kind: Kind): Move {
  return {
    due: false,
    line: () =>
      `дела нет — жди: mpu task wait project: ${project} kind: ${kind.word}`,
  };
}

function due(line: string): Move {
  return { due: true, line: () => line };
}

/** Ход проекта на момент снимка журнала. */
export class Course {
  readonly #project: string;
  readonly #messages: readonly Message[];
  readonly #turn: Turn;

  constructor(project: string, messages: readonly Message[], turn: Turn) {
    this.#project = project;
    this.#messages = messages;
    this.#turn = turn;
  }

  /** Проект остановлен (`stop` без `resume`): шаги не идут. */
  isStopped(): boolean {
    return this.#turn.stopped();
  }

  /** Что сказать исполнителю: непрочитанная постановка — выполнять. */
  exec(): Move {
    const task = this.#last([TASK]);
    if (task === undefined || task.read) return idle(this.#project, TASK);
    return due(`прочитай mpu task read project: ${this.#project} и выполняй`);
  }

  /** Что сказать хосту: непрочитанный отчёт или вопрос без ответа. */
  host(): Move {
    const last = this.#last([REPORT, QUESTION]);
    if (last?.kind === REPORT && !last.read) {
      const n = last.portion;
      return due(
        `прими порцию ${n} по отчёту; спека и постановка ${n + 1} по плану; ` +
          `положи mpu task post project: ${this.#project}`,
      );
    }
    if (last?.kind === QUESTION && !this.#answered(last)) {
      return due(
        `ответь на вопрос исполнителя по порции ${last.portion}: ` +
          `${last.line()} — ответ: mpu task answer project: ${this.#project}`,
      );
    }
    return idle(this.#project, REPORT);
  }

  /** Время последнего сообщения журнала; журнал пуст — 0. */
  lastAt(): number {
    return this.#messages.at(-1)?.at ?? 0;
  }

  /** События проекта на `now`: стоп и вопрос владельцу дольше часа. */
  events(now: number): Event[] {
    const events: Event[] = [];
    const stop = this.#last([STOP]);
    if (this.isStopped() && stop !== undefined) {
      events.push({
        key: `stop@${stop.id}`,
        text: `${this.#project}: остановлен — ${stop.line()}`,
      });
    }
    const owner = this.#last([OWNER, OWNER_ANSWER]);
    if (owner?.kind === OWNER && now - owner.at > HOUR_MS) {
      events.push({
        key: `owner@${owner.id}`,
        text: `${this.#project}: ждёт ответа владельца`,
      });
    }
    return events;
  }

  #last(kinds: readonly Kind[]): Message | undefined {
    return this.#messages.filter((one) => kinds.includes(one.kind)).at(-1);
  }

  #answered(question: Message): boolean {
    return this.#messages.some(
      (one) => one.kind === ANSWER && one.id > question.id,
    );
  }
}
