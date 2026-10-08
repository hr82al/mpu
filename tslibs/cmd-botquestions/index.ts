/**
 * Вопросы владельцу в его чате с ботом
 * (`docs/specs/platform/telegram-questions.md`): потребитель передаёт
 * форму и ждёт исход — ответ, снятие, истечение или отказ показа. Службу
 * на весь процесс создаёт и держит потребитель (сервер ядра приложения):
 * пакет отдаёт её устройство, а не экземпляр. Команд у пакета нет — это
 * домен вопросов, вынесенный серией пакетов команд вместе с `telegram`.
 */

export { CHECKED, Written } from "./src/outcome.ts";
export type {
  AnswerLine,
  Outcome,
  OutcomeReader,
  StepAnswer,
  StepAnswerReader,
} from "./src/outcome.ts";
export {
  ACCEPTED,
  type Button,
  clipLabel,
  OptionKey,
  STALE,
  type StepPressable,
} from "./src/button.ts";
export {
  BOLD_FIRST_LINE,
  type Entity,
  KEEP_TAIL,
  type Markup,
  preformatted,
  type Rendered,
  titled,
} from "./src/card.ts";
export type { Posted, PostedReader } from "./src/chat.ts";
export {
  BUTTONS_ONLY,
  Form,
  LATER,
  MANY,
  MAX_STEPS,
  notice,
  ONE,
  oneClosing,
  type Option,
  type Selection,
  SKIP,
  type Step,
  type StepEvents,
  TAKES_TEXT,
  type TextRule,
  Title,
} from "./src/form.ts";
export { URGENT, WAITS_INPUT } from "./src/row.ts";
export { type Clock, REAL_CLOCK } from "./src/poller.ts";
export type { Asked } from "./src/queue.ts";
export {
  NO_BOT,
  type OwnerQuestions,
  ownerQuestions,
  type QuestionsDeps,
} from "./src/questions.ts";
