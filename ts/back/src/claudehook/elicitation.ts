/**
 * Payload хука `Elicitation` → вопрос владельцу и обратно
 * (`claude-hook-elicitation.md`, «Ввод», «Форма → вопрос», «Ответ →
 * решение»). Разбор — граница чужого формата: поля payload'а и схемы
 * читаются здесь и только здесь; дальше вид поля отвечает сам.
 */

import {
  type AnswerLine,
  BUTTONS_ONLY,
  CHECKED,
  Form,
  MAX_STEPS,
  notice,
  oneClosing,
  type Step,
  type StepAnswer,
  TAKES_TEXT,
  type TextRule,
} from "../botquestions/mod.ts";
import { ELICITATION } from "@mpu/language/frames";
import { type Fields, isFields } from "./fields.ts";
import { projectOf } from "./places.ts";
import {
  DECIDED,
  type HookReply,
  type HookSpeech,
  unparsedInput,
} from "./reply.ts";

/** Без решения: Claude Code показывает форму в терминале. */
export class NoAnswer implements HookReply {
  readonly #reason: string;

  /** @param reason причина из таблиц спеки */
  constructor(reason: string) {
    this.#reason = reason;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    speech.stderr(ELICITATION.undecided(this.#reason));
  }
}

/** Решение хука одной строкой JSON; порядок ключей — как в спеке. */
class Decision implements HookReply {
  readonly #fields: Fields;

  /** @param fields `action` и, у принятой формы, `content` */
  constructor(fields: Fields) {
    this.#fields = fields;
  }

  code = DECIDED;

  tell(speech: HookSpeech) {
    const output = {
      hookSpecificOutput: { hookEventName: "Elicitation", ...this.#fields },
    };
    speech.stdout(`${JSON.stringify(output)}\n`);
  }
}

/** Причина: форма самого mpu — его вопрос уже в чате [S13]. */
export const OWN_FORM = "форма mpu — вопрос уже в чате";

/** Причина: владелец отпустил форму в терминал [S12]. */
export const IN_TERMINAL = "ответ в терминале";

/** Причина: форма-ссылка — ответ по ссылке, решения у хука нет [S14]. */
export const LINK_FORM = "режим url — ответ по ссылке";

const DECLINE = new Decision({ action: "decline" });

/** Чем кончилась форма: решение хука и последняя строка сообщения. */
interface Verdict {
  reply(content: Fields): HookReply;
  line(answers: readonly StepAnswer[]): string;
}

const ACCEPTED: Verdict = {
  reply: (content) => new Decision({ action: "accept", content }),
  line: (answers) => CHECKED.line(answers),
};

const DECLINED: Verdict = {
  reply: () => DECLINE,
  line: () => "❌ Decline — из чата",
};

const TERMINAL_VERDICT: Verdict = {
  reply: () => new NoAnswer(IN_TERMINAL),
  line: () => "↪ ответ в терминале",
};

/** Ответы шагов по порядку: значения полей и чем кончилась форма. */
class Filling {
  readonly #content: [string, unknown][] = [];
  #verdict: Verdict = ACCEPTED;

  set(name: string, value: unknown): void {
    this.#content.push([name, value]);
  }

  end(verdict: Verdict): void {
    this.#verdict = verdict;
  }

  /**
   * Решение. `Object.fromEntries` — чтобы поле `__proto__` стало ключом, а
   * не прототипом.
   */
  reply(): HookReply {
    return this.#verdict.reply(Object.fromEntries(this.#content));
  }

  line(answers: readonly StepAnswer[]): string {
    return this.#verdict.line(answers);
  }
}

/** Ответ шага глазами решения. */
interface FieldAnswer {
  apply(filling: Filling): void;
}

function valueOf(name: string, value: unknown): FieldAnswer {
  return { apply: (filling) => filling.set(name, value) };
}

/** Шаг пропущен или отвечает форму без полей: значения нет. */
const NO_VALUE: FieldAnswer = { apply: () => {} };

/** Кнопка шага: подпись и что значит её нажатие. */
interface Offer {
  readonly label: string;
  readonly answer: FieldAnswer;
}

const SKIP_OFFER: Offer = { label: "Пропустить", answer: NO_VALUE };

/** Кнопки, кончающие форму на любом шаге: их число — для `oneClosing`. */
const CLOSING: readonly Offer[] = [
  { label: "Decline", answer: { apply: (filling) => filling.end(DECLINED) } },
  {
    label: "В терминале",
    answer: { apply: (filling) => filling.end(TERMINAL_VERDICT) },
  },
];

/** Вид поля схемы: кнопки шага, свой текст и значение из него. */
interface Field {
  readonly offers: readonly Offer[];
  readonly reply: TextRule;
  /** Значение из текста, принятого правилом `reply`. */
  written(text: string): FieldAnswer;
}

/** Поле схемы по месту в форме: само решает, как войти в план шагов. */
interface Described {
  into(plan: Plan, title: string, extra: readonly Offer[]): Plan;
}

function described(field: Field): Described {
  return {
    into: (plan, title, extra) => plan.add({ title, field, extra }),
  };
}

/**
 * Поле, которого из чата не заполнить (объект, массив, незнакомый тип):
 * вся форма — только `Decline` / `В терминале`.
 */
const UNFILLABLE: Described = { into: () => CLOSED_PLAN };

/** Поле кнопок: свой текст шагу не доходит (`BUTTONS_ONLY`). */
function buttonsField(offers: readonly Offer[]): Field {
  return { offers, reply: BUTTONS_ONLY, written: () => NO_VALUE };
}

function booleanField(name: string): Field {
  return buttonsField([
    { label: "Да", answer: valueOf(name, true) },
    { label: "Нет", answer: valueOf(name, false) },
  ]);
}

/** Кнопки значений; подписи — `enumNames`, если их столько же. */
function enumField(
  name: string,
  values: readonly string[],
  names: readonly string[],
): Field {
  return buttonsField(
    values.map((value, index) => ({
      label: names[index] ?? value,
      answer: valueOf(name, value),
    })),
  );
}

function textField(name: string): Field {
  return {
    offers: [],
    reply: TAKES_TEXT,
    written: (text) => valueOf(name, text),
  };
}

const NEED_NUMBER = notice("нужно число");

/**
 * Число текстом: не число — подсказка, шаг остаётся [S10]. Десятичная
 * запятая принимается наравне с точкой.
 *
 * @param numeric число ли это поле, по тексту без пробелов по краям
 */
function numberField(name: string, numeric: (text: string) => boolean): Field {
  const normal = (text: string) => text.trim().replace(",", ".");
  return {
    offers: [],
    reply: {
      write: (text, events) =>
        numeric(normal(text))
          ? TAKES_TEXT.write(normal(text), events)
          : NEED_NUMBER,
    },
    written: (text) => valueOf(name, Number(text)),
  };
}

/** Целое без потери точности. */
function isInteger(text: string): boolean {
  return /^[-+]?\d+$/.test(text) && Number.isSafeInteger(Number(text));
}

function isNumber(text: string): boolean {
  return /^[-+]?\d+(\.\d+)?$/.test(text);
}

/** Поле схемы и его шаг. */
interface Entry {
  /** Текст шага, кроме первого: `title`, иначе имя поля. */
  readonly title: string;
  readonly field: Field;
  /** Кнопки сверх значений: необязательное поле — `Пропустить`. */
  readonly extra: readonly Offer[];
}

/** Шаг формы: что показать и как прочитать его ответ. */
interface FormStep {
  readonly step: Step;
  read(answer: StepAnswer): FieldAnswer;
}

function formStep(
  head: string,
  text: string,
  offers: readonly Offer[],
  field: Pick<Field, "reply" | "written">,
): FormStep {
  const all = [...offers, ...CLOSING];
  return {
    step: {
      head,
      text,
      options: all.map((offer) => ({ label: offer.label })),
      choice: oneClosing(CLOSING.length),
      reply: field.reply,
    },
    read: (answer) =>
      answer.read({
        picked: ([index]) => all[index].answer,
        wrote: (text) => field.written(text),
      }),
  };
}

/** Что задать: шаги и чтение ответов. */
interface Steps {
  steps(head: string, message: string): readonly FormStep[];
}

/** Поля по шагу на каждое, в порядке схемы. */
function fieldSteps(entries: readonly Entry[]): Steps {
  return {
    steps: (head, message) =>
      entries.map((entry, index) =>
        formStep(
          head,
          index === 0 ? message : entry.title,
          [...entry.field.offers, ...entry.extra],
          entry.field,
        ),
      ),
  };
}

/** Схема без полей: `Accept` или конец формы [S9]. */
const ACCEPT_ONLY: Steps = {
  steps: (head, message) => [
    formStep(
      head,
      message,
      [{ label: "Accept", answer: NO_VALUE }],
      buttonsField([]),
    ),
  ],
};

/** Поле, которое из чата не заполнить: только `Decline` / `В терминале`. */
const CLOSE_ONLY: Steps = {
  steps: (head, message) => [formStep(head, message, [], buttonsField([]))],
};

/** Откуда название сессии: транскрипт, если payload его назвал. */
export interface TitleSource {
  title(
    read: (path: string) => Promise<readonly string[]>,
  ): Promise<readonly string[]>;
}

const UNTITLED: TitleSource = { title: () => Promise.resolve([]) };

function titleAt(path: string): TitleSource {
  return { title: (read) => read(path) };
}

/** Форма с полями — вопрос владельцу и решение по его ответам. */
export class ElicitQuestion {
  readonly #head: string;
  readonly #steps: readonly FormStep[];
  /** Место «проект»: базовое имя `cwd`. */
  readonly project: readonly string[];
  readonly title: TitleSource;

  constructor(options: {
    readonly server: string;
    readonly message: string;
    readonly steps: Steps;
    readonly project: readonly string[];
    readonly title: TitleSource;
  }) {
    this.#head = `📝 ${options.server}`;
    this.#steps = options.steps.steps(this.#head, options.message);
    this.project = options.project;
    this.title = options.title;
  }

  /** Вопрос владельцу; `places` — сессия, проект, окно. */
  form(places: readonly string[]): Form {
    const line: AnswerLine = {
      line: (answers) => this.#filled(answers).line(answers),
    };
    return new Form({
      places,
      steps: this.#steps.map((one) => one.step),
      answerLine: line,
    });
  }

  /** Решение по ответам шагов. */
  decide(answers: readonly StepAnswer[]): HookReply {
    return this.#filled(answers).reply();
  }

  #filled(answers: readonly StepAnswer[]): Filling {
    const filling = new Filling();
    answers.forEach((answer, i) => this.#steps[i].read(answer).apply(filling));
    return filling;
  }
}

/** Что нужно разобранному payload'у, чтобы ответить хуку. */
export interface ElicitAsking {
  /** Задать форму владельцу и дождаться решения. */
  ask(question: ElicitQuestion): Promise<HookReply>;
  /** Сообщение без кнопок: заголовок и текст. */
  tell(title: string, text: string): Promise<void>;
}

/** Разобранный payload: отвечает хуку сам. */
export interface Elicitation {
  reply(asking: ElicitAsking): Promise<HookReply>;
}

function answered(reply: HookReply): Elicitation {
  return { reply: () => Promise.resolve(reply) };
}

const OWN: Elicitation = answered(new NoAnswer(OWN_FORM));

/** Форма-ссылка: уведомление без кнопок, решения нет [S14]. */
function link(server: string, message: string, url: unknown): Elicitation {
  const lines = typeof url === "string" ? [message, url] : [message];
  return {
    reply: async (asking) => {
      await asking.tell(`📝 ${server}`, lines.join("\n"));
      return new NoAnswer(LINK_FORM);
    },
  };
}

/** Поле схемы по его описанию. */
function fieldOf(name: string, spec: unknown): Described {
  if (!isFields(spec)) return UNFILLABLE;
  // Тип поля схемы — данные границы чужого формата.
  switch (spec.type) {
    case "boolean":
      return described(booleanField(name));
    case "string": {
      const values = stringsOf(spec.enum);
      if (values.length === 0) return described(textField(name));
      return described(
        enumField(name, values, labelsOf(spec.enumNames, values.length)),
      );
    }
    case "integer":
      return described(numberField(name, isInteger));
    case "number":
      return described(numberField(name, isNumber));
    default:
      return UNFILLABLE;
  }
}

/** Строки списка; не список строк — пусто. */
function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.every((one) => typeof one === "string") ? value : [];
}

/** Подписи `enumNames`, если их столько же, сколько значений. */
function labelsOf(value: unknown, count: number): readonly string[] {
  const labels = stringsOf(value);
  return labels.length === count ? labels : [];
}

/** Шаги, собираемые по полям схемы. */
interface Plan {
  add(entry: Entry): Plan;
  steps(): Steps;
}

/** Только `Decline` / `В терминале`: поле не заполнить или шагов не хватит. */
const CLOSED_PLAN: Plan = { add: () => CLOSED_PLAN, steps: () => CLOSE_ONLY };

/** Поля по порядку схемы; шагов у вопроса не больше `MAX_STEPS`. */
function planOf(entries: readonly Entry[]): Plan {
  return {
    add: (entry) =>
      entries.length < MAX_STEPS ? planOf([...entries, entry]) : CLOSED_PLAN,
    steps: () => (entries.length === 0 ? ACCEPT_ONLY : fieldSteps(entries)),
  };
}

/**
 * Шаги по схеме: без полей — `Accept`; поле, которого из чата не
 * заполнить, или полей больше, чем шагов у вопроса, — вся форма только
 * `Decline` / `В терминале`.
 */
function stepsOf(schema: unknown): Steps {
  if (!isFields(schema) || !isFields(schema.properties)) return CLOSE_ONLY;
  const { properties } = schema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties)
    .reduce((plan, [name, spec]) => {
      const title =
        isFields(spec) && typeof spec.title === "string" ? spec.title : name;
      const extra = required.includes(name) ? [] : [SKIP_OFFER];
      return fieldOf(name, spec).into(plan, title, extra);
    }, planOf([]))
    .steps();
}

const NOT_OBJECT = "stdin — не JSON-объект";

/**
 * Разбор stdin хука по таблице «Ввод»: требования сверху вниз, первое
 * нарушенное — причина; незнакомые поля игнорируются.
 *
 * @param text stdin целиком
 */
export function elicitationOf(text: string): Elicitation {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return answered(new NoAnswer(unparsedInput(NOT_OBJECT)));
  }
  if (!isFields(payload)) {
    return answered(new NoAnswer(unparsedInput(NOT_OBJECT)));
  }
  const server = payload.mcp_server_name;
  if (typeof server !== "string") {
    return answered(new NoAnswer(unparsedInput("нет mcp_server_name")));
  }
  const message = payload.message;
  if (typeof message !== "string") {
    return answered(new NoAnswer(unparsedInput("нет message")));
  }
  if (server === MPU_SERVER) return OWN;
  if (payload.mode === "url") return link(server, message, payload.url);
  const question = new ElicitQuestion({
    server,
    message,
    steps: stepsOf(payload.requested_schema),
    project: projectOf(payload.cwd),
    title:
      typeof payload.transcript_path === "string"
        ? titleAt(payload.transcript_path)
        : UNTITLED,
  });
  return { reply: (asking) => asking.ask(question) };
}

/** Имя MCP-сервера самого mpu: его форму уже задал mpu [S13]. */
const MPU_SERVER = "mpu";
