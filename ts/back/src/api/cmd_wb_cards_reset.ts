/**
 * Команда `mpu api wb-cards-reset` (`docs/specs/api-wb-cards-reset.md`):
 * сброс курсора загрузчика карточек, чтобы ближайший прогон сделал
 * полный перечит.
 *
 * Своя механика — резолв селектора до sid. Загрузчик ключуется по sid,
 * а клиент и сервер для него косметика, отсюда два режима: прямой (sid
 * задан или селектор сам им является) и через кэш. Прямой не читает
 * кэш вовсе — не «не позвал», а не открывает его.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import {
  type CacheReader,
  type Candidate,
  formatCandidates,
  isSidLike,
  searchCandidates,
} from "../selector/mod.ts";
import { openSlback, type SlbackSession } from "../slback/mod.ts";
import { asDomainError } from "./command.ts";

/** Путь и тело сняты с объекта дословно (спека, «Путь и тело»). */
export const RESET_PATH = (sid: string) =>
  `/admin/wb-loader/loaders/${encodeURIComponent(sid)}/cards/v1/reset`;

/**
 * Тело фиксировано: сброс курсора и есть вся операция. Своего `--body`
 * у команды нет — собирать нечего, и опция, которой можно было бы
 * послать другое тело, означала бы другую команду.
 */
export const RESET_BODY = { state: { cursor: null } } as const;

const argsSchema = z.object({
  selector: z.string({ error: "нужен СЕЛЕКТОР: клиент, кабинет или таблица" })
    .describe("селектор: sid, client_id, таблица, заголовок"),
  sid: z.string().optional().describe("явный WB sid: прямой режим"),
  "client-id": z.string().optional().describe(
    "сузить неоднозначный селектор до одного клиента",
  ),
  print: z.boolean().default(false).describe(
    "напечатать эквивалентный вызов и выйти, ничего не отправляя",
  ),
});

const resultSchema = z.object({
  sid: z.string().describe("кабинет, чей курсор сбрасываем"),
  path: z.string().describe("путь запроса"),
  direct: z.boolean().describe("прямой режим: кэш не открывался"),
  printed: z.boolean().describe("вызов только напечатан, не отправлен"),
  response: z.unknown().describe("ответ сервера; у печати — null"),
});

type ResetArgs = z.infer<typeof argsSchema>;
type ResetResult = z.infer<typeof resultSchema>;

/** Подстановки для тестов: живого sl-back у них нет. */
export interface ResetOptions {
  readonly session?: SlbackSession;
}

type ResetIo = Pick<CommandIo, "envFile" | "openCacheDb"> & CommandIo;

/** Прямой режим: sid известен без кэша. */
function directSid(args: ResetArgs): string | undefined {
  if (args.sid !== undefined) return args.sid;
  // Селектор сам имеет форму sid — резолвить нечего: загрузчику нужен
  // именно он, а кэш подтвердил бы лишь то, что мы и так держим в руках.
  return isSidLike(args.selector) ? args.selector : undefined;
}

/**
 * Sid из кэша. Несколько — отказ с перечнем: молчаливый выбор первого
 * отправил бы сброс чужому кабинету (спека, инвариант 2).
 */
function resolveSid(
  cache: CacheReader,
  env: ResetIo["envFile"],
  args: ResetArgs,
): string {
  const candidates = searchCandidates({ cache, env }, args.selector);
  const narrowed = narrow(candidates, args["client-id"]);
  const sids = [...new Set(narrowed.flatMap((one) => one.sids))].sort();
  if (sids.length === 0) {
    throw new UsageError(
      `у селектора '${args.selector}' нет WB-кабинетов` +
        (narrowed.length === 0 ? "" : "; кандидаты:\n" +
          formatCandidates(narrowed)),
      { hint: "mpu search " + args.selector },
    );
  }
  if (sids.length > 1) {
    throw new UsageError(
      `у селектора '${args.selector}' несколько кабинетов:\n` +
        sids.map((sid) => `  ${sid}\n`).join("") +
        "укажи нужный через --sid",
    );
  }
  return sids[0];
}

/** Сужение кандидатов до одного клиента, если он назван. */
function narrow(
  candidates: readonly Candidate[],
  clientId: string | undefined,
): readonly Candidate[] {
  if (clientId === undefined) return candidates;
  const wanted = Number(clientId);
  if (!Number.isInteger(wanted)) {
    throw new UsageError(
      `--client-id: ожидается число, получено '${clientId}'`,
    );
  }
  return candidates.filter((one) => one.clientId === wanted);
}

export async function runCardsReset(
  args: ResetArgs,
  io: ResetIo,
  options: ResetOptions = {},
): Promise<ResetResult> {
  const direct = directSid(args);
  // Кэш открывается только там, где он нужен: в прямом режиме команда
  // работает и при недоступном кэше (спека, инвариант 1).
  const sid = direct ?? resolveWithCache(args, io);
  const path = RESET_PATH(sid);
  const head = { sid, path, direct: direct !== undefined };
  if (args.print) {
    // Печать ничего не выполняет: ни одного запроса к серверу
    // (инвариант 3). Резолв к этому моменту уже сделан — он и есть то,
    // ради чего печать зовут.
    return { ...head, printed: true, response: null };
  }
  const session = options.session ?? openSlback(io);
  try {
    return {
      ...head,
      printed: false,
      response: await session.call("POST", path, RESET_BODY),
    };
  } catch (err) {
    throw asDomainError(err);
  }
}

/** Открытие кэша и резолв в нём; закрывается сразу после. */
function resolveWithCache(args: ResetArgs, io: ResetIo): string {
  using db = io.openCacheDb();
  const cache: CacheReader = {
    query: (sql, ...params) => db.query(sql, ...params),
  };
  return resolveSid(cache, io.envFile, args);
}

/**
 * Эквивалентный вызов для печати. Токен не подставляется даже когда он
 * под рукой: строка попадёт на экран, в буфер и, вероятно, в чужую
 * переписку — а живой Bearer там не нужен никому
 * (`ts/CLAUDE.md`: секреты в вывод не попадают ни в каком виде).
 */
export function curlOf(result: ResetResult): string {
  return [
    "curl -X POST \\",
    `  \"$BASE_API_URL${result.path}\" \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify(RESET_BODY)}'`,
  ].join("\n") + "\n";
}

export const wbCardsResetCommand = defineCommand({
  path: ["api", "wb-cards-reset"],
  errorName: "api wb-cards-reset",
  summary: "Форсировать полный проход загрузчика карточек WB-кабинета.",
  usage: "mpu api wb-cards-reset СЕЛЕКТОР [--sid SID] [--client-id ID] [-p]",
  help: `Сбрасывает курсор загрузчика wbCards в пустое значение:
ближайший прогон делает полный перечит карточек. Нужно после
переклейки — маркетплейс не обновляет отметку времени карточки при
изменении одной лишь склейки, и инкрементальный проход её пропускает.

Загрузчик ключуется по WB sid, поэтому режима два. Прямой: задан --sid
либо сам СЕЛЕКТОР имеет форму sid (UUID) — кэш тогда не открывается
вовсе. Иначе селектор резолвится по кэшу, как в mpu search.

Несколько кабинетов у селектора — отказ с перечнем и требованием
--sid, а не выбор первого: сброс ушёл бы чужому кабинету. --client-id
сужает неоднозначный селектор до одного клиента.

-p/--print печатает эквивалентный вызов и выходит, ничего не отправляя;
токен в строке не подставляется, вместо него $TOKEN.

Тело запроса фиксировано ({"state": {"cursor": null}}), своего --body у
команды нет. Право на запись проверяет сервер.

Exit: 0 — успех; 1 — отказ sl-back; 2 — селектор не резолвится либо
кабинетов несколько.

Пример: mpu api wb-cards-reset 777 --print`,
  policy: "rw",
  argsSchema,
  forms: { selector: { positional: "one" }, print: { short: "p" } },
  resultSchema,
  run: (args: ResetArgs, io: ResetIo) => runCardsReset(args, io),
  render: (result: ResetResult) =>
    result.printed
      ? curlOf(result)
      : `${JSON.stringify(result.response, null, 2)}\n`,
});
