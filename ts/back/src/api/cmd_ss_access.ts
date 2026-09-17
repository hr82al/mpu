/**
 * Команды `mpu api ss-access request|status|revoke|reset`
 * (`docs/specs/api-ss-access.md`).
 *
 * Получатель доступа всегда владелец токена: эндпоинт выдаёт доступ
 * тому, чьим токеном ходят, и своего параметра у этого нет намеренно —
 * иначе командой можно было бы выдать доступ постороннему.
 *
 * Из четырёх только `status` обходится без main-БД. Прочие резолвят
 * идентификатор выдачи в ней (`ss_access.ts`), и её отказ — своя
 * ошибка со своим кодом: чинить недоступную базу и недоступный sl-back
 * приходится в разных местах.
 */

import { z } from "@zod/zod";
import {
  type Command,
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import { openSlback, type SlbackSession } from "../slback/mod.ts";
import { slbackCredentials } from "../slback/config.ts";
import { denoSession, type OpenSession, serverTarget } from "../sql/mod.ts";
import type { SqlSession } from "../sql/session.ts";
import { asDomainError } from "./command.ts";
import {
  activeGrants,
  type Grant,
  JOBS_PATH,
  reasonOf,
  requestBody,
  RESET_REVOKE_REASON,
  REVOKE_REASON,
  revokeBody,
  WAIT_LIMIT_MS,
  waitGone,
  WaitTimeoutError,
} from "./ss_access.ts";

/** Номер сервера main-БД: тот же, с которого `mpu update` берёт клиентов. */
const MAIN_SERVER = 0;

/** Подстановки для тестов: живых sl-back и PostgreSQL у них нет. */
export interface SsAccessOptions {
  readonly session?: SlbackSession;
  readonly openSession?: OpenSession;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly limitMs?: number;
}

type SsIo = CommandIo;

const spreadsheet = z.string({ error: "нужен ТАБЛИЦА: идентификатор таблицы" })
  .describe("идентификатор таблицы (spreadsheet_id)");

const grantSchema = z.object({ id: z.string(), status: z.string() });

/** Путь эндпоинта доступа; идентификатор экранируется, как везде. */
function accessPath(ssId: string, tail = ""): string {
  return `/admin/ss/${encodeURIComponent(ssId)}/my-access${tail}`;
}

/** Почта владельца токена: получатель доступа и ключ резолва. */
function granteeEmail(io: SsIo): string {
  return slbackCredentials(io.envFile, {}).email;
}

/** Сеанс sl-back: настоящий либо подставленный тестом. */
function slback(io: SsIo, options: SsAccessOptions): SlbackSession {
  return options.session ?? openSlback(io);
}

/** Сессия main-БД только на чтение: резолву запись не нужна. */
async function mainDb(
  io: SsIo,
  options: SsAccessOptions,
): Promise<SqlSession> {
  const open = options.openSession ?? denoSession("read-only");
  return await open(serverTarget(io.envFile, MAIN_SERVER));
}

/** Вызов sl-back; его отказ — доменная ошибка команды. */
async function call(
  session: SlbackSession,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  try {
    return await session.call(method, path, body);
  } catch (err) {
    throw asDomainError(err);
  }
}

const requestArgs = z.object({
  spreadsheet,
  role: z.string().optional().describe("googleSheetsRole; только editor"),
  reason: z.string().optional().describe("обоснование, 3..500 символов"),
  template: z.string().optional().describe("accessTemplateId (UUID)"),
  body: z.string().optional().describe(
    "полный JSON тела или @файл; отменяет --role/--reason/--template",
  ),
});

const responseResult = z.object({
  response: z.unknown().describe("ответ sl-back как есть"),
});

type RequestArgs = z.infer<typeof requestArgs>;

/** Тело `request`: либо `--body` целиком, либо авто-тело с правками. */
async function requestPayload(
  args: RequestArgs,
  io: SsIo,
): Promise<unknown> {
  if (args.body === undefined) {
    return requestBody({
      role: args.role,
      reason: args.reason,
      template: args.template,
    });
  }
  // `--body` отменяет точечные опции, а не смешивается с ними: два
  // источника одного поля означали бы неявное старшинство, о котором
  // оператор узнавал бы по результату (спека, инвариант 3).
  if (
    args.role !== undefined || args.reason !== undefined ||
    args.template !== undefined
  ) {
    throw new UsageError(
      "--body задаёт тело целиком; --role/--reason/--template с ним не " +
        "сочетаются — оставь что-то одно",
    );
  }
  return await bodyText(args.body, io);
}

/** `--body`: JSON-литерал либо содержимое файла по `@путь`. */
async function bodyText(raw: string, io: SsIo): Promise<unknown> {
  let text = raw;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      text = await io.readTextFile(path);
    } catch (err) {
      throw new UsageError(`--body @${path}: ${reasonOf(err)}`, { cause: err });
    }
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--body: невалидный JSON: ${reasonOf(err)}`, {
      cause: err,
    });
  }
}

export async function runRequest(
  args: RequestArgs,
  io: SsIo,
  options: SsAccessOptions = {},
): Promise<{ response: unknown }> {
  // Тело собирается до сети: негодный `--body` не стоит обращения
  // наружу, а `@файл` может и не найтись.
  const payload = await requestPayload(args, io);
  return {
    response: await call(
      slback(io, options),
      "POST",
      accessPath(args.spreadsheet, "/request"),
      payload,
    ),
  };
}

export const ssAccessRequestCommand = defineCommand({
  path: ["api", "ss-access", "request"],
  errorName: "api ss-access request",
  summary: "POST /admin/ss/<ss>/my-access/request — выдать себе доступ.",
  usage: "mpu api ss-access request ТАБЛИЦА [--role R] [--reason T] [-b JSON]",
  help: `Выдаёт или продлевает доступ владельцу токена (TOKEN_EMAIL) —
ровно как кнопка в sl-front. Получателя выбрать нельзя: эндпоинт
выдаёт доступ тому, чьим токеном ходят.

Без опций уходит авто-тело кнопки: роль editor, обоснование по
умолчанию, accessTemplateId null. --role/--reason/--template правят
отдельные поля.

-b/--body задаёт тело целиком ('<json>' или @файл) и с точечными
опциями не сочетается: у поля не должно быть двух источников.

Exit: 0 — успех; 1 — отказ sl-back; 2 — ошибки ввода.

Пример: mpu api ss-access request 1BxiMVs0 --reason 'разбор обращения'`,
  policy: "rw",
  argsSchema: requestArgs,
  forms: { spreadsheet: { positional: "one" }, body: { short: "b" } },
  resultSchema: responseResult,
  run: (args: RequestArgs, io: SsIo) => runRequest(args, io),
  render: (result) => printResponse(result.response),
});

export async function runStatus(
  args: { spreadsheet: string },
  io: SsIo,
  options: SsAccessOptions = {},
): Promise<{ response: unknown }> {
  return {
    response: await call(
      slback(io, options),
      "GET",
      accessPath(args.spreadsheet),
    ),
  };
}

export const ssAccessStatusCommand = defineCommand({
  path: ["api", "ss-access", "status"],
  errorName: "api ss-access status",
  summary: "GET /admin/ss/<ss>/my-access — текущие активные доступы.",
  usage: "mpu api ss-access status ТАБЛИЦА",
  help: `Показывает активные доступы владельца токена к таблице.
Только чтение: ни выдач, ни отзывов эта команда не делает и в main-БД
не ходит.

Exit: 0 — успех; 1 — отказ sl-back; 2 — ошибки ввода.

Пример: mpu api ss-access status 1BxiMVs0`,
  policy: "ro",
  argsSchema: z.object({ spreadsheet }),
  forms: { spreadsheet: { positional: "one" } },
  resultSchema: responseResult,
  run: (args, io: SsIo) => runStatus(args, io),
  render: (result) => printResponse(result.response),
});

const revokeArgs = z.object({
  spreadsheet,
  "grant-id": z.string().optional().describe(
    "явный идентификатор выдачи; иначе резолв из main-БД",
  ),
  reason: z.string().optional().describe("причина отзыва"),
});

const revokeResult = z.object({
  revoked: z.array(grantSchema).describe("отозванные выдачи"),
  responses: z.array(z.unknown()).describe("ответы очереди по каждой"),
});

type RevokeArgs = z.infer<typeof revokeArgs>;
type RevokeResult = z.infer<typeof revokeResult>;

/**
 * Отзыв найденных выдач по одной. Величина берётся отсюда — из числа
 * поставленных job'ов, а не из длины входа: `--grant-id` даёт одну, а
 * резолв сколько нашёл (спека, инвариант 2).
 */
async function revokeGrants(
  session: SlbackSession,
  grants: readonly Grant[],
  reason: string,
): Promise<RevokeResult> {
  // Цикл — по списку, в котором не больше одной строки: уникальность
  // держит частичный индекс базы (`ss_access.ts`,
  // `UNIQUE_ACTIVE_INDEX`), и вторую выдачу резолв не вернёт, а
  // отобьёт. Отсюда здесь нет ни счётчика отозванных, ни сообщения о
  // частичном отзыве: код, стерегущий невозможное состояние, читается
  // как утверждение, что оно бывает, и следующий читатель будет
  // искать, когда же.
  const responses: unknown[] = [];
  for (const grant of grants) {
    responses.push(
      await call(session, "POST", JOBS_PATH, revokeBody(grant.id, reason)),
    );
  }
  return { revoked: [...grants], responses };
}

/** Выдачи к отзыву: явная либо найденные резолвом. */
async function targets(
  args: RevokeArgs,
  io: SsIo,
  options: SsAccessOptions,
): Promise<readonly Grant[]> {
  const explicit = args["grant-id"];
  if (explicit !== undefined) return [{ id: explicit, status: "(задан)" }];
  const db = await mainDb(io, options);
  try {
    return await activeGrants(db, args.spreadsheet, granteeEmail(io));
  } finally {
    await db.close();
  }
}

export async function runRevoke(
  args: RevokeArgs,
  io: SsIo,
  options: SsAccessOptions = {},
): Promise<RevokeResult> {
  return await revokeGrants(
    slback(io, options),
    await targets(args, io, options),
    args.reason ?? REVOKE_REASON,
  );
}

export const ssAccessRevokeCommand = defineCommand({
  path: ["api", "ss-access", "revoke"],
  errorName: "api ss-access revoke",
  summary: "Отозвать доступ (job accessGrantRevoke).",
  usage: "mpu api ss-access revoke ТАБЛИЦА [--grant-id G] [--reason T]",
  help: `Ставит job отзыва на каждую активную выдачу владельца токена.
Без --grant-id идентификаторы резолвятся из main-БД: таблица
public.spreadsheets_access_grants, статусы created, permission_added и
applied — те, что входят в частичный уникальный индекс активной
выдачи.

Выдач не нашлось — код 0 и строка «отзывать нечего»: состояние уже
целевое, отказывать не в чем. Недоступная main-БД — код 2 с указанием,
что упал резолв, а не запрос к sl-back.

Exit: 0 — успех; 1 — отказ sl-back; 2 — ошибки ввода и отказ резолва.

Пример: mpu api ss-access revoke 1BxiMVs0`,
  policy: "rw",
  argsSchema: revokeArgs,
  forms: { spreadsheet: { positional: "one" } },
  resultSchema: revokeResult,
  run: (args: RevokeArgs, io: SsIo) => runRevoke(args, io),
  render: renderRevoke,
});

/**
 * При нуле найденных строки с числом нет вовсе: «отозвано 0» и
 * «отзывать было нечего» — разные исходы, и первый читается как
 * неудача там, где её нет (спека, инвариант 2).
 */
export function renderRevoke(result: RevokeResult): string {
  if (result.revoked.length === 0) return "отзывать нечего\n";
  return `отозвано выдач: ${result.revoked.length}\n` +
    result.revoked.map((grant) => `  ${grant.id} (${grant.status})\n`).join("");
}

const resetArgs = z.object({
  spreadsheet,
  reason: z.string().optional().describe("обоснование последующей выдачи"),
  role: z.string().optional().describe("googleSheetsRole; только editor"),
  template: z.string().optional().describe("accessTemplateId (UUID)"),
});

const resetResult = z.object({
  revoked: z.array(grantSchema).describe("отозванные выдачи"),
  waitedMs: z.number().describe("сколько ждали исчезновения из индекса"),
  response: z.unknown().describe("ответ на повторную выдачу"),
});

type ResetArgs = z.infer<typeof resetArgs>;
type ResetResult = z.infer<typeof resetResult>;

/**
 * `reset` = отозвать всё найденное → дождаться выхода из индекса →
 * выдать заново. Причина отзыва здесь своя, жёсткая: `--reason`
 * относится ко второй половине, к выдаче.
 */
export async function runReset(
  args: ResetArgs,
  io: SsIo,
  options: SsAccessOptions = {},
): Promise<ResetResult> {
  const email = granteeEmail(io);
  const session = slback(io, options);
  const now = options.now ?? (() => Date.now());
  const db = await mainDb(io, options);
  const started = now();
  let revoked: readonly Grant[];
  try {
    revoked = await activeGrants(db, args.spreadsheet, email);
    await revokeGrants(session, revoked, RESET_REVOKE_REASON);
    if (revoked.length > 0) {
      await waitGone(
        db,
        args.spreadsheet,
        email,
        { now, sleep: options.sleep ?? sleep },
        options.limitMs ?? WAIT_LIMIT_MS,
      );
    }
  } catch (err) {
    if (err instanceof WaitTimeoutError) {
      // Молчаливый успех после истечения запрещён: повторная выдача
      // упёрлась бы в тот же индекс, и оператор узнал бы об этом от
      // сервера, а не от нас (спека, инвариант 1).
      throw new DomainError(err.message, {
        cause: err,
        advice: "конвейер отзыва застрял; истеки строку выдачи вручную и " +
          "повтори",
      });
    }
    throw err;
  } finally {
    await db.close();
  }
  return {
    revoked: [...revoked],
    waitedMs: now() - started,
    response: await call(
      session,
      "POST",
      accessPath(args.spreadsheet, "/request"),
      requestBody({
        role: args.role,
        reason: args.reason,
        template: args.template,
      }),
    ),
  };
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export const ssAccessResetCommand = defineCommand({
  path: ["api", "ss-access", "reset"],
  errorName: "api ss-access reset",
  summary: "Отозвать застрявшую выдачу, дождаться и выдать заново.",
  usage: "mpu api ss-access reset ТАБЛИЦА [--reason T] [--role R]",
  help: `Три шага: отозвать все активные выдачи владельца токена,
дождаться их исчезновения из уникального индекса, выдать доступ
заново.

Ожидание не бесконечно: опрос раз в 3 секунды, предел 60 секунд.
Истёк — код 1, и сообщение называет предел и оставшиеся выдачи;
молчаливого успеха тут быть не может, иначе повторная выдача упёрлась
бы в тот же индекс.

--reason относится к ПОВТОРНОЙ ВЫДАЧЕ, а не к отзыву: причина отзыва
внутри reset своя и не настраивается.

Exit: 0 — успех; 1 — отказ sl-back либо истёкшее ожидание; 2 — ошибки
ввода и отказ резолва в main-БД.

Пример: mpu api ss-access reset 1BxiMVs0`,
  policy: "rw",
  argsSchema: resetArgs,
  forms: { spreadsheet: { positional: "one" } },
  resultSchema: resetResult,
  run: (args: ResetArgs, io: SsIo) => runReset(args, io),
  render: (result: ResetResult) => {
    const head = result.revoked.length === 0
      ? "отзывать нечего\n"
      : `отозвано выдач: ${result.revoked.length}, ` +
        `ждали ${Math.round(result.waitedMs / 1000)} с\n`;
    return head + printResponse(result.response);
  },
});

/** Ответ сервера как есть; пустой — пустой вывод, а не `null`. */
function printResponse(response: unknown): string {
  if (response === undefined) return "";
  return `${JSON.stringify(response, null, 2)}\n`;
}

/** Команды группы в порядке справки. */
export const ssAccessCommands: readonly Command[] = [
  ssAccessRequestCommand,
  ssAccessStatusCommand,
  ssAccessRevokeCommand,
  ssAccessResetCommand,
];
