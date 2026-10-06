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
export type { Button } from "./button.ts";
export { KEEP_TAIL } from "./card.ts";
export {
  BUTTONS_ONLY,
  Form,
  LATER,
  MANY,
  notice,
  ONE,
  type Option,
  SKIP,
  type Step,
  TAKES_TEXT,
  type TextRule,
  Title,
} from "./form.ts";
export { WAITS_INPUT } from "./row.ts";
export { type Clock, REAL_CLOCK } from "./poller.ts";
export type { Asked } from "./queue.ts";
export {
  NO_BOT,
  type OwnerQuestions,
  ownerQuestions,
  type QuestionsDeps,
} from "./questions.ts";
