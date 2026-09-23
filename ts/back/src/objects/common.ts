/**
 * Вид результата «данные» с его объектом-значением. Данные понимают только
 * протокол отражения и закрытие: цепочка на них окончена.
 */

import { Description } from "./method.ts";
import { DATA_REFLECTION, dataHelp, ended } from "./result.ts";
import { withProtocol } from "./reflection.ts";
import { NO_REMEDY } from "./remedy.ts";
import type {
  Call,
  Outcome,
  Receiver,
  Report,
  Sent,
  Yields,
} from "./protocol.ts";

/** Данные в конце цепочки: любое сообщение к ним — отказ. */
class Value implements Receiver {
  readonly #data: unknown;

  constructor(data: unknown) {
    this.#data = data;
  }

  lookup(sent: Sent): Call {
    return ended(this, sent);
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.value(this.#data));
  }
}

/** Вид результата «данные». */
export const DATA: Yields<unknown> = {
  parsing: () => withProtocol(new Description()).build(),
  about: (path, doc) => dataHelp(path, doc),
  remedy: () => NO_REMEDY,
  reflect: () => DATA_REFLECTION,
  receive: (data) => new Value(data),
};
