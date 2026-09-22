/**
 * Сообщения корня о правилах подтверждения (`platform/policy.md`,
 * «Сообщения корню»). Их исполнение — ответ на конец строки: так
 * `allow: x --help` показывает справку, ничего не записав, а сообщение
 * после них отказывает раньше, чем правило записано.
 */

import {
  type Call,
  DATA,
  type Doc,
  ended,
  keyword,
  type Method,
  type Outcome,
  type Receiver,
  Refusal,
  type Report,
  type Sent,
  unary,
  type Yields,
} from "../objects/mod.ts";
import {
  ALLOW,
  ASK,
  type Change,
  DENY,
  EmptyRulePath,
  FORGET,
  RulePath,
} from "../policy/mod.ts";
import type { Line } from "./dispatch.ts";
import { POLICY_SELECTOR } from "./seeds.ts";

/** То, что сообщение сделает в конце строки. */
interface Pending {
  finish(report: Report): Promise<Outcome>;
}

/** Данные, получаемые в конце строки: дальше сообщений нет. */
class Deferred implements Receiver {
  readonly #pending: Pending;

  constructor(pending: Pending) {
    this.#pending = pending;
  }

  /** Как у данных в конце цепочки: отказ всему, кроме закрытия. */
  lookup(sent: Sent): Call {
    return ended(this, sent);
  }

  final(report: Report): Promise<Outcome> {
    return this.#pending.finish(report);
  }
}

/** Вид результата: справка и разбор — как у данных. */
const DEFERRED: Yields<Pending> = {
  parsing: () => DATA.parsing(),
  about: (path, doc) => DATA.about(path, doc),
  remedy: (word) => DATA.remedy(word),
  receive: (pending) => new Deferred(pending),
};

const LIST_DOC: Doc = {
  purpose: "правила подтверждения",
  help: "Звать перед тем, как менять правило или разбираться, почему строку\n" +
    "спросили или запретили: показывает, что сейчас лежит в файле правил.\n\n" +
    "Список правил подтверждения: путь правила и решение (allow — выполнить,\n" +
    "ask — спросить, deny — отказать), по пути правила; * — корень.\n" +
    "Правило действует на свой путь и всё под ним, побеждает самое длинное\n" +
    "совпадение; не совпало ни одно — ask.",
};

/** Сообщения изменения правила и их справка. */
const CHANGE_DOCS: readonly (readonly [Change, Doc])[] = [
  [ALLOW, {
    purpose: "разрешить путь без вопроса",
    help: 'Записывает правило allow на пути: mpu allow: "kiten card".\n' +
      "Спрашивает подтверждение у человека; без человека — отказ.",
  }],
  [ASK, {
    purpose: "спрашивать перед исполнением пути",
    help: 'Записывает правило ask на пути: mpu ask: "kiten comment".\n' +
      "Спрашивает подтверждение у человека; без человека — отказ.",
  }],
  [DENY, {
    purpose: "запретить путь",
    help: 'Записывает правило deny на пути: mpu deny: "sql".\n' +
      "Спрашивает подтверждение у человека; без человека — отказ.",
  }],
  [FORGET, {
    purpose: "снять правило с пути",
    help:
      'Удаляет правило на пути, путь снова наследует: mpu forget: "sql".\n' +
      "Спрашивает подтверждение у человека; без человека — отказ.",
  }],
];

/** Путь правила из значения ключа; пустой — отказ объекта. */
function rulePath(value: string | boolean): RulePath {
  try {
    return RulePath.parse(String(value));
  } catch (err) {
    if (!(err instanceof EmptyRulePath)) throw err;
    throw new Refusal(err.message, { cause: err });
  }
}

function changeMethod([change, doc]: readonly [Change, Doc]): Method<Line> {
  return keyword(
    { [change.word]: "value" },
    [change.word],
    doc,
    DEFERRED,
    (line: Line, args) => {
      const path = rulePath(args[change.word]);
      return { finish: (report) => line.change(report, path, change) };
    },
  );
}

/** Пять методов корня: `policy`, `allow:`, `ask:`, `deny:`, `forget:`. */
export function ruleMethods(): Method<Line>[] {
  return [
    unary(POLICY_SELECTOR, LIST_DOC, DEFERRED, (line: Line) => ({
      finish: (report: Report) => line.listRules(report),
    })),
    ...CHANGE_DOCS.map(changeMethod),
  ];
}

/**
 * Метод корня, который даёт дверь (`specs/web.md`, «Вход в браузере»):
 * данные в конце строки, справка его не исполняет.
 */
export interface RootMethod {
  readonly selector: string;
  readonly doc: Doc;
  produce(): Promise<unknown>;
}

/** Метод корня двери как метод дерева. */
export function rootMethod(method: RootMethod): Method<Line> {
  return unary(method.selector, method.doc, DEFERRED, () => ({
    finish: async (report: Report) => report.value(await method.produce()),
  }));
}
