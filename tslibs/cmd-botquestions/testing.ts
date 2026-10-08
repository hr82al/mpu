/**
 * Вход `@mpu/cmd-botquestions/testing`: поддельный бот с готовыми ответами
 * голдена, служба вопросов над ним, нажатие кнопки и текст владельца
 * апдейтами, форма в один шаг — и отказ Bot API (`BotFailure`), которым
 * тест подделывает непоказанную карточку. Их берут тесты потребителей
 * (сервер ядра, хуки Claude Code, клиент, MCP); копии стенда у них нет.
 */

export { BotFailure } from "./src/bot_api.ts";
export {
  f1,
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "./src/testbot.ts";
