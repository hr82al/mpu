/**
 * Команда `mpu telegram login` (`docs/specs/telegram-login.md`):
 * интерактивный вход, сохраняющий сессию в env-файл. Опций нет.
 *
 * Здесь только склейка: сценарий — `login.ts`, живой клиент —
 * `login_client.ts` (подгружается лениво и только когда до входа
 * дошло). Разделение не украшение: без него ни одна ветка отказа не
 * проверялась бы без настоящего Telegram.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import { parseProxy, type ProxySettings } from "./proxy.ts";
import {
  type LoginClient,
  type LoginIo,
  type LoginResult,
  runLogin,
} from "./login.ts";

const argsSchema = z.object({});

const resultSchema = z.object({
  status: z.enum(["already", "skipped", "logged-in"]).describe(
    "already — сессия уже была; skipped — вход не состоялся; logged-in — сессия записана",
  ),
  reason: z.string().optional().describe("причина пропуска, если он был"),
});

type LoginArgs = z.infer<typeof argsSchema>;
type LoginCommandResult = z.infer<typeof resultSchema>;

/** Срез порта: env-файл, терминал и строка хода. */
type LoginCommandIo = Pick<
  CommandIo,
  "envFile" | "openTerminal" | "progress"
>;

/** Прокси только для Telegram — те же источники, что у сеанса. */
const PROXY_KEYS = ["TELEGRAM_PROXY", "HTTPS_PROXY", "https_proxy"] as const;

function proxyOf(io: LoginCommandIo): ProxySettings | undefined {
  for (const key of PROXY_KEYS) {
    const value = io.envFile.get(key);
    if (value !== undefined && value !== "") return parseProxy(value);
  }
  return undefined;
}

/**
 * Тот же вход, что у команды, — для шага 5 `mpu init`
 * (`docs/specs/init.md`). Общая точка, а не копия склейки: две
 * реализации одного шага уже стояли рядом и могли разойтись молча.
 *
 * Отдаёт исход сценария как есть: шагу нужна причина пропуска, а не
 * проекция результата команды.
 */
export async function runTelegramLoginStep(
  io: LoginCommandIo,
): Promise<LoginResult> {
  using terminal = await io.openTerminal();
  const port: LoginIo = {
    envFile: io.envFile,
    terminal,
    progress: io.progress,
    // Ленивый импорт: крипта MTProto и её wasm не должны попадать в
    // старт каждого вызова `mpu`, а до входа доходит меньшинство
    // прогонов — все отказы сценария случаются раньше.
    openClient: async (keys): Promise<LoginClient> => {
      const { openLoginClient } = await import("./login_client.ts");
      return openLoginClient(keys, proxyOf(io));
    },
  };
  return await runLogin(port);
}

async function runLoginCommand(
  _args: LoginArgs,
  io: LoginCommandIo,
): Promise<LoginCommandResult> {
  const result = await runTelegramLoginStep(io);
  // Проекция исхода в результат команды: у объединения причина есть
  // только у пропуска, у схемы результата поле необязательное.
  return result.status === "skipped"
    ? { status: result.status, reason: result.reason }
    : { status: result.status };
}

export const telegramLoginCommand = defineCommand({
  path: ["telegram", "login"],
  errorName: "telegram login",
  summary: "Вход в Telegram: сохранить пользовательскую сессию в env-файл.",
  usage: "mpu telegram login",
  help: `Интерактивный вход от имени пользователя: сессия сохраняется в
env-файл, и остальные команды семейства работают без повторного входа.
Та же реализация — шаг входа в mpu init.

Сессия уже есть — вход не запускается: повторный вход отзывает прежнюю
сессию, и это защита, а не удобство.

Ни один отказ сценария не даёт ненулевого кода: нет терминала, отказ
заводить ключи приложения, пустой ввод — всё это «пропущено» с кодом 0.
Команда сообщает, чего не сделала, и не мешает остальному — иначе она
роняла бы mpu init тому, кто просто не хочет настраивать Telegram.

Ключи приложения (TELEGRAM_API_ID, TELEGRAM_API_HASH) берутся с
https://my.telegram.org/apps; телефон сохраняется в env-файл и
переживает неудачный вход, пароль второго фактора вводится скрыто и не
сохраняется вовсе.

Строка сессии — полноценный доступ к аккаунту: она не печатается, не
попадает в журнал вызовов и не появляется в текстах ошибок.

Exit: 0 — успех и любой пропуск; 1 — отказ Telegram.`,
  policy: "rw",
  // Вывод в журнал не пишется: единственное место, где строка сессии
  // могла бы оказаться на диске вторым экземпляром, — перехваченный
  // вывод (`platform/invoke-log.md`). Аргументов у команды нет вовсе,
  // поэтому argv пишется как есть.
  logsOutput: false,
  argsSchema,
  resultSchema,
  run: runLoginCommand,
  // Всё, что видит человек, идёт строками хода в stderr: у входа нет
  // результата, который имело бы смысл печатать в stdout.
  render: () => "",
});
