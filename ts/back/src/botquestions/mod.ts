/**
 * Вопросы владельцу в его чате с ботом
 * (`docs/specs/platform/telegram-questions.md`): потребитель передаёт
 * форму и ждёт исход — ответ, снятие, истечение или отказ показа. Ядро
 * держит службу на весь процесс (`../backend/`).
 */

export { CHECKED, EXPIRED_LINE, Written } from "./outcome.ts";
export type {
  AnswerLine,
  Outcome,
  OutcomeReader,
  StepAnswer,
  StepAnswerReader,
} from "./outcome.ts";
export {
  ACCEPTED,
  type Button,
  clipLabel,
  OptionKey,
  STALE,
  type StepPressable,
} from "./button.ts";
export {
  BOLD_FIRST_LINE,
  type Entity,
  KEEP_TAIL,
  type Markup,
  preformatted,
  type Rendered,
} from "./card.ts";
export type { Posted, PostedReader } from "./chat.ts";
export {
  BUTTONS_ONLY,
  Form,
  LATER,
  MANY,
  notice,
  ONE,
  type Option,
  type Selection,
  SKIP,
  type Step,
  type StepEvents,
  TAKES_TEXT,
  type TextRule,
  Title,
} from "./form.ts";
export { URGENT, WAITS_INPUT } from "./row.ts";
export { type Clock, REAL_CLOCK } from "./poller.ts";
export type { Asked } from "./queue.ts";
export {
  NO_BOT,
  type OwnerQuestions,
  ownerQuestions,
  type QuestionsDeps,
} from "./questions.ts";
