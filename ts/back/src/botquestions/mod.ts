/**
 * Вопросы владельцу в его чате с ботом
 * (`docs/specs/platform/telegram-questions.md`): потребитель передаёт
 * форму и ждёт исход — ответ, снятие, истечение или отказ показа. Ядро
 * держит службу на весь процесс (`../backend/`).
 */

export { CHECKED, EXPIRED_LINE } from "./outcome.ts";
export type {
  AnswerLine,
  Outcome,
  OutcomeReader,
  StepAnswer,
  StepAnswerReader,
} from "./outcome.ts";
export { type Clip, KEEP_HEAD, KEEP_TAIL } from "./card.ts";
export {
  BUTTONS_ONLY,
  Form,
  LATER,
  MANY,
  ONE,
  type Option,
  SKIP,
  type Step,
  TAKES_TEXT,
  Title,
} from "./form.ts";
export { type Kind, URGENT, WAITS_INPUT } from "./row.ts";
export { type Clock, REAL_CLOCK } from "./poller.ts";
export type { Asked } from "./queue.ts";
export {
  NO_BOT,
  type OwnerQuestions,
  ownerQuestions,
  type QuestionsDeps,
} from "./questions.ts";
