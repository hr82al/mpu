/**
 * Команда `mpu api get-token` (`api.md`, «get-token / auth-login»):
 * напечатать accessToken sl-back — из кэша, если он жив, иначе логином.
 *
 * Кастомная, а не декларативная: печатает не ответ сервера, а одно
 * поле из него, и единственная в семействе умеет обойти кэш при чтении.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, DomainError } from "../command/mod.ts";
import { NoAccessTokenError, openSlback } from "../slback/mod.ts";
import { asDomainError } from "./command.ts";

const argsSchema = z.object({
  email: z.string().optional().describe(
    "login email; по умолчанию TOKEN_EMAIL из env-файла",
  ),
  password: z.string().optional().describe(
    "пароль; по умолчанию TOKEN_PASSWORD из env-файла",
  ),
});

const resultSchema = z.object({
  token: z.string().describe("accessToken sl-back"),
});

type TokenArgs = z.infer<typeof argsSchema>;
type TokenResult = z.infer<typeof resultSchema>;

async function runGetToken(
  args: TokenArgs,
  io: CommandIo,
): Promise<TokenResult> {
  // Оба флага заданы — кэш при чтении игнорируется: оператор явно
  // назвал другого пользователя, и отдать ему чужой живой токен было бы
  // ответом не на тот вопрос. Записывается кэш всё равно: следующая
  // команда должна работать от того же пользователя.
  const explicit = args.email !== undefined && args.password !== undefined;
  try {
    return {
      token: await openSlback(io).token({
        overrides: { email: args.email, password: args.password },
        useCache: !explicit,
      }),
    };
  } catch (err) {
    if (err instanceof NoAccessTokenError) {
      // Свой текст, короче общего: тело ответа логина сюда не идёт —
      // в нём бывает всё, вплоть до эха кред (`api.md`).
      throw new DomainError("нет accessToken в ответе sl-back", { cause: err });
    }
    throw asDomainError(err);
  }
}

export const apiGetTokenCommand = defineCommand({
  path: ["api", "get-token"],
  errorName: "api get-token",
  summary: "POST /auth/login → print accessToken (cached 10 min)",
  usage: "mpu api get-token [--email E] [--password P]",
  help: `Печатает accessToken sl-back одной строкой — без JSON-обёртки, чтобы
его можно было подставить в curl: TOKEN=$(mpu api get-token).

Без явных кред: живой токен из кэша печатается без обращения к сети;
иначе идёт логин на TOKEN_EMAIL / TOKEN_PASSWORD из env-файла, и токен
кладётся в кэш ~/.config/mpu/.api-token.json на 10 минут.

--email и --password: заданный флаг старше env по своему полю. Заданы
оба — кэш при чтении игнорируется (всегда свежий логин), и запись кэша
перезаписывается под названного пользователя.

Ни токен, ни пароль не попадают в журнал вызовов: у команды не пишутся
ни аргументы, ни вывод.

Exit: 0 — успех; 2 — ошибки ввода; 1 — сеть, HTTP ≥ 400, ответ без
accessToken, отсутствие конфигурации.`,
  policy: "ro",
  // Пароль приходит аргументом, поэтому argv в журнал не пишется; вывод
  // — живой токен, и он тем более не пишется (`api.md`, «Побочные
  // эффекты»: вывод get-token в журнал не перехватывается).
  logsArguments: false,
  logsOutput: false,
  argsSchema,
  resultSchema,
  run: runGetToken,
  render: (result: TokenResult) => `${result.token}\n`,
});
