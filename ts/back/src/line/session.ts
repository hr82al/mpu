/**
 * Строка с её правилами и каналом (`platform/policy.md`,
 * «Когда проверяется»): исполнение и список правил проходят решение
 * правил, изменение правила — только ответ человека.
 */

import type { Output } from "../entrypoint/mod.ts";
import type { Outcome, Report } from "../objects/mod.ts";
import {
  type Change,
  type Channel,
  PolicyError,
  type RuleBook,
  type RulePath,
  type Ruling,
} from "../policy/mod.ts";
import type { Line } from "./dispatch.ts";
import { selectorFirstWriters } from "./seeds.ts";

/** Код отказа правил и изменения правил. */
const REFUSED = 1;

/** Из чего собрана строка. */
export interface SessionParts {
  readonly book: RuleBook;
  readonly channel: Channel;
  readonly output: Output;
  /** Исходная строка нынешней диспетчеризации; итог — код. */
  readonly dispatch: () => Promise<number>;
}

/** Строка вызова одного процесса. */
export class Session implements Line {
  readonly #book: RuleBook;
  readonly #channel: Channel;
  readonly #output: Output;
  readonly #dispatch: () => Promise<number>;

  constructor(parts: SessionParts) {
    this.#book = parts.book;
    this.#channel = parts.channel;
    this.#output = parts.output;
    this.#dispatch = parts.dispatch;
  }

  dispatch(report: Report): Promise<Outcome> {
    return this.#ruled(report, async () => report.exit(await this.#dispatch()));
  }

  listRules(report: Report): Promise<Outcome> {
    return this.#ruled(
      report,
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

  /** Решение правил для пути строки исполняет свой исход. */
  #ruled(report: Report, run: () => Promise<Outcome>): Promise<Outcome> {
    let ruling: Ruling;
    try {
      ruling = this.#book.decide(report.links());
    } catch (err) {
      return this.#broken(report, err);
    }
    return ruling.settle({
      text: report.text(),
      run,
      refuse: (reason) => this.#refuse(report, reason),
    }, this.#channel);
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
