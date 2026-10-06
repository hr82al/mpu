/**
 * Payload хука `PermissionRequest` → вопрос владельцу и обратно
 * (`claude-hook-permission-request.md`, «Ввод», «Payload → форма
 * вопроса», «Ответ → решение»). Разбор — граница чужого формата: поля
 * payload'а читаются здесь и только здесь; вид вопроса (право или
 * AskUserQuestion) дальше отвечает сам.
 */

import {
  type AnswerLine,
  CHECKED,
  Form,
  MANY,
  ONE,
  type Option,
  type Step,
  type StepAnswer,
  TAKES_TEXT,
} from "../botquestions/mod.ts";
import { ALLOW, DENY, PermissionDecision } from "./decision.ts";
import type { HookReply } from "./reply.ts";
import { type Fields, isFields } from "./fields.ts";
import { projectOf } from "./places.ts";
import { type Suggestion, suggestionsOf } from "./suggestion.ts";

/** Вид вопроса: что спросить и как ответы становятся решением. */
export interface Asking {
  /** Форма вопроса; `places` — места заголовка по порядку. */
  form(places: readonly string[]): Form;
  /** Решение Claude Code по ответам шагов формы. */
  decide(answers: readonly StepAnswer[]): HookReply;
}

/** Вызов инструмента так, как его пишет транскрипт: имя и вход. */
export interface ToolUse {
  readonly name: string;
  readonly input: Fields;
}

/** Разобранный payload. */
export interface PermissionRequest {
  readonly asking: Asking;
  readonly call: ToolUse;
  /** Транскрипт сессии: название и признак ответа в терминале. */
  readonly transcriptPath: string;
  /** Место «проект»: базовое имя `cwd`; нет — пусто. */
  readonly project: readonly string[];
}

/** Чтение исхода разбора. */
export interface PayloadReader<T> {
  /** Требование таблицы «Ввод» нарушено: `what` — какое. */
  unparsed(what: string): T;
  parsed(request: PermissionRequest): T;
}

/** Исход разбора stdin. */
export interface PermissionPayload {
  read<T>(reader: PayloadReader<T>): T;
}

function unparsed(what: string): PermissionPayload {
  return { read: (reader) => reader.unparsed(what) };
}

/** Вариант вопроса о праве: подпись, решение и строка исхода. */
interface Choice {
  readonly label: string;
  decision(): HookReply;
  /** Последняя строка сообщения, когда нажат этот вариант. */
  line(): string;
}

const YES: Choice = {
  label: "Yes",
  decision: () => ALLOW,
  line: () => "✅ Yes — из чата",
};

const NO: Choice = {
  label: "No",
  decision: () => DENY,
  line: () => "❌ No — из чата",
};

/** «Всегда» по подсказке: Claude Code сам запишет правило. */
class Always implements Choice {
  readonly label: string;
  readonly #suggestion: Suggestion;

  constructor(suggestion: Suggestion) {
    this.#suggestion = suggestion;
    this.label = `Yes, always: ${suggestion.label()}`;
  }

  decision(): HookReply {
    return new PermissionDecision("allow", {
      updatedPermissions: [this.#suggestion.raw()],
    });
  }

  line(): string {
    return `✅ ${this.label} — из чата`;
  }
}

/** Текст владельца на вопрос о праве — отказ с пояснением. */
function refusedWith(text: string): HookReply {
  return new PermissionDecision("deny", { message: text });
}

/** Вопрос о праве: один шаг, варианты `Yes`, подсказки, `No`. */
class ToolPermission implements Asking {
  readonly #head: string;
  readonly #text: string;
  readonly #choices: readonly Choice[];

  constructor(head: string, text: string, choices: readonly Choice[]) {
    this.#head = head;
    this.#text = text;
    this.#choices = choices;
  }

  form(places: readonly string[]): Form {
    const choices = this.#choices;
    const line: AnswerLine = {
      line: (answers) =>
        answers[0].read({
          picked: ([index]) => choices[index].line(),
          wrote: (text) => `❌ No: ${text} — из чата`,
        }),
    };
    return new Form({
      places,
      steps: [{
        head: `🔐 ${this.#head}`,
        text: this.#text,
        options: choices.map((choice) => ({ label: choice.label })),
        choice: ONE,
        reply: TAKES_TEXT,
      }],
      answerLine: line,
    });
  }

  decide(answers: readonly StepAnswer[]): HookReply {
    return answers[0].read({
      picked: ([index]) => this.#choices[index].decision(),
      wrote: refusedWith,
    });
  }
}

/** Вопрос AskUserQuestion: шаг на каждый вопрос. */
interface UserQuestion {
  /** Голова заголовка шага: `header` вопроса. */
  readonly header: string;
  readonly question: string;
  readonly options: readonly Option[];
  readonly many: boolean;
}

/** AskUserQuestion: ответы уходят в `updatedInput` одним решением. */
class UserQuestions implements Asking {
  readonly #questions: readonly UserQuestion[];
  /** `questions` как пришли: Claude Code ждёт их обратно. */
  readonly #raw: unknown;

  constructor(questions: readonly UserQuestion[], raw: unknown) {
    this.#questions = questions;
    this.#raw = raw;
  }

  form(places: readonly string[]): Form {
    return new Form({
      places,
      steps: this.#questions.map((one): Step => ({
        head: `❓ ${one.header}`,
        text: one.question,
        options: one.options,
        choice: one.many ? MANY : ONE,
        reply: TAKES_TEXT,
      })),
      answerLine: CHECKED,
    });
  }

  /**
   * Ответы по тексту вопроса; одинаковый текст двух вопросов — второй
   * затирает первый: так ключует Claude Code (граница чужого формата).
   * `Object.fromEntries` — чтобы вопрос `__proto__` стал ключом, а не
   * прототипом.
   */
  decide(answers: readonly StepAnswer[]): HookReply {
    const pairs = this.#questions.map((one, i) => [
      one.question,
      answers[i].read({
        picked: (indices) =>
          indices.map((index) => one.options[index].label).join(", "),
        wrote: (text) => text,
      }),
    ]);
    return new PermissionDecision("allow", {
      updatedInput: {
        questions: this.#raw,
        answers: Object.fromEntries(pairs),
      },
    });
  }
}

const NOT_OBJECT = "stdin — не JSON-объект";

/** Имя инструмента в заголовке: MCP-тул — `<тул> (MCP)`. */
function toolHead(name: string): string {
  const mcp = /^mcp__.+?__(.+)$/.exec(name);
  return mcp === null ? name : `${mcp[1]} (MCP)`;
}

/** Вход одной строкой JSON; пустой — `(без аргументов)`. */
function inputLine(input: Fields): string {
  return Object.keys(input).length === 0
    ? "(без аргументов)"
    : JSON.stringify(input);
}

/** Текст шага права: описание, затем команда, иначе вход одной строкой. */
function permissionText(input: Fields): string {
  const lines = typeof input.description === "string"
    ? [input.description]
    : [];
  lines.push(
    typeof input.command === "string" ? input.command : inputLine(input),
  );
  return lines.join("\n");
}

function toolPermission(name: string, payload: Fields, input: Fields) {
  const always = suggestionsOf(payload.permission_suggestions).map(
    (suggestion) => new Always(suggestion),
  );
  return new ToolPermission(
    toolHead(name),
    permissionText(input),
    [YES, ...always, NO],
  );
}

/** Вариант AskUserQuestion; без строкового `label` — негоден. */
function optionOf(value: unknown): Option | undefined {
  if (!isFields(value) || typeof value.label !== "string") return undefined;
  return typeof value.description === "string"
    ? { label: value.label, description: value.description }
    : { label: value.label };
}

/** Вопрос AskUserQuestion по таблице «Ввод»; негоден — `undefined`. */
function userQuestionOf(value: unknown): UserQuestion | undefined {
  if (!isFields(value) || typeof value.question !== "string") return undefined;
  const raw = value.options;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) {
    return undefined;
  }
  const options = raw.map(optionOf);
  if (options.some((option) => option === undefined)) return undefined;
  return {
    // Голова шага — `header` своего вопроса (`platform/telegram-questions.md`,
    // «R2»); нет его — общее слово.
    header: typeof value.header === "string" ? value.header : "Вопрос",
    question: value.question,
    options: options.filter((option) => option !== undefined),
    many: value.multiSelect === true,
  };
}

/** AskUserQuestion: 1–4 вопроса, каждый годен; иначе — `undefined`. */
function userQuestions(input: Fields): UserQuestions | undefined {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) {
    return undefined;
  }
  const questions = raw.map(userQuestionOf);
  if (questions.some((one) => one === undefined)) return undefined;
  return new UserQuestions(
    questions.filter((one) => one !== undefined),
    raw,
  );
}

/**
 * Разбор stdin хука по таблице «Ввод»: требования сверху вниз, первое
 * нарушенное — причина; незнакомые поля игнорируются.
 *
 * @param text stdin целиком
 */
export function permissionPayloadOf(text: string): PermissionPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return unparsed(NOT_OBJECT);
  }
  if (!isFields(payload)) return unparsed(NOT_OBJECT);
  const name = payload.tool_name;
  if (typeof name !== "string" || name === "") return unparsed("нет tool_name");
  const input = payload.tool_input;
  if (!isFields(input)) return unparsed("tool_input — не объект");
  let asking: Asking;
  switch (name) {
    case "AskUserQuestion": {
      const questions = userQuestions(input);
      if (questions === undefined) return unparsed("questions");
      asking = questions;
      break;
    }
    default:
      asking = toolPermission(name, payload, input);
  }
  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string") {
    return unparsed("нет transcript_path");
  }
  const request: PermissionRequest = {
    asking,
    call: { name, input },
    transcriptPath,
    project: projectOf(payload.cwd),
  };
  return { read: (reader) => reader.parsed(request) };
}
