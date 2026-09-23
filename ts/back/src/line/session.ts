/**
 * Строка с её правилами и каналом (`platform/policy.md`,
 * «Когда проверяется»): исполнение и список правил проходят решение
 * правил, изменение правила — только ответ человека.
 */

import type { Command } from "../command/mod.ts";
import type { Delivery, Output } from "../entrypoint/mod.ts";
import type { Data, Outcome, Report } from "../objects/mod.ts";
import {
  type Change,
  type Channel,
  PolicyError,
  type RuleBook,
  type RulePath,
  type Ruling,
} from "../policy/mod.ts";
import type { Line } from "./dispatch.ts";
import { printed } from "./printed.ts";
import { selectorFirstWriters } from "./seeds.ts";
import type { Order } from "./order.ts";
import { NORMAL, toDoor, type View } from "./view.ts";

/** Код отказа правил и изменения правил. */
const REFUSED = 1;

/** Из чего собрана строка. */
export interface SessionParts {
  readonly book: RuleBook;
  readonly channel: Channel;
  readonly output: Output;
  /**
   * Строка нынешней диспетчеризацией, какой её видит `view` и собирает
   * `order`; результат уходит доставкой `delivery` (нет — печать); итог
   * — код.
   */
  readonly dispatch: (
    view: View,
    order: Order,
    delivery?: Delivery,
  ) => Promise<number>;
  /** Результат строки — поток. */
  readonly streams: (view: View, order: Order) => boolean;
}

/** Что отбор получил от исполнения. */
interface Take {
  /** Итог строки с кодом `code`: отбор над данными или код как есть. */
  finish(
    code: number,
    replay: (data: Data) => Promise<Outcome>,
    report: Report,
    output: Output,
  ): Promise<Outcome>;
}

/** Результата нет — команда упала: её отказ уже напечатан, код — её. */
const NOTHING_TAKEN: Take = {
  finish: (code, _replay, report) => Promise.resolve(report.exit(code)),
};

/** Результат команды — данными отбору. */
class Delivered implements Take {
  readonly #data: Data;

  constructor(data: Data) {
    this.#data = data;
  }

  /** Отобранное печатается; код — команды, если печать не отказала. */
  async finish(
    code: number,
    replay: (data: Data) => Promise<Outcome>,
    report: Report,
    output: Output,
  ): Promise<Outcome> {
    const shown = printed(await replay(this.#data), output);
    return report.exit(shown === 0 ? code : shown);
  }
}

/** Доставка отбора: результат не печатается, а запоминается данными. */
class Taking implements Delivery {
  #taken: Take = NOTHING_TAKEN;

  deliver(command: Command, result: unknown, args: readonly string[]) {
    this.#taken = new Delivered(command.dataOf(result, args));
    return command.textExitCode(result);
  }

  finish(
    code: number,
    replay: (data: Data) => Promise<Outcome>,
    report: Report,
    output: Output,
  ): Promise<Outcome> {
    return this.#taken.finish(code, replay, report, output);
  }
}

/** Строка вызова одного процесса. */
export class Session implements Line {
  readonly #book: RuleBook;
  readonly #channel: Channel;
  readonly #output: Output;
  readonly #dispatch: SessionParts["dispatch"];
  readonly #streams: SessionParts["streams"];

  constructor(parts: SessionParts) {
    this.#book = parts.book;
    this.#channel = parts.channel;
    this.#output = parts.output;
    this.#dispatch = parts.dispatch;
    this.#streams = parts.streams;
  }

  dispatch(report: Report, view: View, order: Order): Promise<Outcome> {
    return this.#ruled(
      report,
      view,
      async () => report.exit(await this.#dispatch(view, order)),
    );
  }

  streams(view: View, order: Order): boolean {
    return this.#streams(view, order);
  }

  select(
    report: Report,
    view: View,
    order: Order,
    replay: (data: Data) => Promise<Outcome>,
  ): Promise<Outcome> {
    return this.#ruled(report, view, async () => {
      const taking = new Taking();
      const code = await this.#dispatch(view, order, taking);
      return await taking.finish(code, replay, report, this.#output);
    });
  }

  /** Сообщение корня обычного взгляда: у двери его нет. */
  listRules(report: Report): Promise<Outcome> {
    return this.#ruled(
      report,
      NORMAL,
      () => this.#guarded(report, () => report.value(this.#book.list())),
    );
  }

  /** Правилами не решается: всегда спрашивает канал (жёсткий запрет). */
  change(report: Report, path: RulePath, change: Change): Promise<Outcome> {
    return this.#channel.amend(change.question(path, selectorFirstWriters), {
      yes: () =>
        this.#guarded(
          report,
          () => report.value(change.apply(this.#book, path)),
        ),
      no: () => this.#refuse(report, `${report.text()}: не подтверждено`),
      absent: () =>
        this.#refuse(report, "изменить правила может только человек"),
    });
  }

  /** Решение правил для пути строки исполняет свой исход у взгляда. */
  #ruled(
    report: Report,
    view: View,
    run: () => Promise<Outcome>,
  ): Promise<Outcome> {
    let ruling: Ruling;
    try {
      ruling = this.#book.decide(report.links());
    } catch (err) {
      return this.#broken(report, err);
    }
    return ruling.settle(
      {
        text: report.text(),
        run,
        refuse: (reason) => this.#refuse(report, reason),
        redirect: () => toDoor(report),
      },
      this.#channel,
      view,
    );
  }

  /** Работа с файлом правил: его сбой — отказ строки. */
  #guarded(report: Report, act: () => Outcome): Promise<Outcome> {
    try {
      return Promise.resolve(act());
    } catch (err) {
      return this.#broken(report, err);
    }
  }

  /** Сбой файла правил — отказ строки его текстом; прочее — дальше. */
  #broken(report: Report, err: unknown): Promise<Outcome> {
    if (!(err instanceof PolicyError)) throw err;
    return this.#refuse(report, err.message);
  }

  #refuse(report: Report, reason: string): Promise<Outcome> {
    this.#output.stderr(`${reason}\n`);
    return Promise.resolve(report.exit(REFUSED));
  }
}
