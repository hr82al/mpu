/**
 * Команда `mpu telegram status` (`docs/specs/telegram-status.md`):
 * дневной отчёт о моих перемещениях карточек — себе или в указанный чат.
 *
 * Здесь склейка: журнал — `kiten/card_move.ts`, живой опрос —
 * `status_live.ts`, текст — `status_report.ts`, отправка — `send.ts`.
 * Живой клиент MTProto подгружается лениво и только тогда, когда
 * отправка вообще нужна: `--dry-run` сеанса не открывает.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand } from "../command/mod.ts";
import {
  getCurrentUser,
  type KaitenAccess,
  kaitenBaseUrl,
  KaitenError,
  listBoardColumns,
  listCardLocationHistory,
  listCards,
  requireKaitenAccess,
} from "../kaiten/mod.ts";
import { movesInWindow } from "../kiten/card_move.ts";
import { telegramConfig } from "./config.ts";
import { inputError } from "./errors.ts";
import { EMPTY_TARGET, parsePeer, type Peer } from "./peer.ts";
import { sendMessage } from "./send.ts";
import { renderSent, type SentView } from "./send_view.ts";
import { type DayWindow, mskDayWindow } from "./status_day.ts";
import {
  liveMoves,
  liveSkippedWarning,
  type LiveSource,
} from "./status_live.ts";
import {
  type CardMove,
  cutToLimit,
  reportStyle,
  reportText,
} from "./status_report.ts";

/** Предел одного сообщения Telegram, в символах. */
const MESSAGE_LIMIT = 4096;

const argsSchema = z.object({
  chat: z.string().optional().describe(
    "адресат: me, id, @username, ссылка t.me, телефон или название чата",
  ),
  live: z.boolean().default(true).describe(
    "дополнять журнал живым опросом Kaiten",
  ),
  "dry-run": z.boolean().default(false).describe(
    "напечатать отчёт в stdout, не отправляя",
  ),
});

const sentSchema = z.object({
  id: z.number().describe("номер отправленного сообщения"),
  chat_id: z.number().describe("маркированный id чата, куда легло сообщение"),
  date: z.string().nullable().describe(
    "время отправки по данным Telegram, ISO-8601; не сообщено — null",
  ),
});

const resultSchema = z.object({
  text: z.string().describe(
    "текст отчёта целиком, без усечения; собран из журнала и живого опроса",
  ),
  sent: sentSchema.nullable().describe(
    "результат отправки; при --dry-run — null, отправки не было",
  ),
});

type TelegramStatusArgs = z.infer<typeof argsSchema>;
type TelegramStatusResult = z.infer<typeof resultSchema>;

/** Срез порта: env-файл, кэш-БД и строка предупреждения. */
type StatusIo = Pick<CommandIo, "envFile" | "openCacheDb" | "progress">;

/**
 * Порядок шагов: адресат проверяется до любой сети, включая Kaiten;
 * дальше сбор, текст и — если это не `--dry-run` — отправка
 * (там же, «Инварианты»).
 */
async function runTelegramStatus(
  args: TelegramStatusArgs,
  io: StatusIo,
): Promise<TelegramStatusResult> {
  const dryRun = args["dry-run"];
  const target = dryRun ? null : requireTarget(
    args.chat ?? io.envFile.get("TELEGRAM_DEFAULT_CHAT"),
  );
  // Момент один на вызов: окно сбора и шапка отчёта обязаны говорить об
  // одном и том же дне, даже если вызов пришёлся на полночь.
  const nowMs = Date.now();
  const window = mskDayWindow(nowMs);
  const cardUrl = cardUrlOf(kaitenBaseUrl(io.envFile));
  const moves = [
    ...journalMoves(io, window, cardUrl),
    ...(args.live ? await liveOrWarn(io, window, cardUrl) : []),
  ];
  const text = reportText(
    moves,
    window.day,
    reportStyle({
      columns: io.envFile.get("KITEN_COLUMN_MAP"),
      emoji: io.envFile.get("KITEN_STATUS_EMOJI"),
    }),
  );
  if (target === null) return { text, sent: null };
  return { text, sent: await send(io, target, text) };
}

/** Адресат вызова: его отсутствие — ошибка ввода, до единого запроса. */
function requireTarget(raw: string | undefined): TargetPeer {
  if (raw === undefined || raw === "") throw inputError(EMPTY_TARGET);
  return { target: raw, peer: parsePeer(raw) };
}

/** Адресат вместе со строкой, которой его задал пользователь. */
interface TargetPeer {
  readonly target: string;
  readonly peer: Peer;
}

/** Web-URL карточки: он же подставляется строкам журнала без ссылки. */
function cardUrlOf(baseUrl: string): (cardId: number) => string {
  return (cardId) => `${baseUrl}/${cardId}`;
}

/** Перемещения из журнала: кэш-БД открывается и закрывается на месте. */
function journalMoves(
  io: StatusIo,
  window: DayWindow,
  cardUrl: (cardId: number) => string,
): readonly CardMove[] {
  using db = io.openCacheDb();
  return movesInWindow(db, window.fromSec, window.toSec).map((row) => ({
    cardId: row.cardId,
    title: row.title,
    url: row.url ?? cardUrl(row.cardId),
    column: row.toColumn,
    movedAt: row.movedAt,
  }));
}

/**
 * Живой опрос как дополнение: любой его отказ — строка в stderr и отчёт
 * на одном журнале. Ненастроенный ключ доступа сюда же: он такой же
 * повод пропустить обогащение, а не уронить команду (там же, «Известные
 * отклонения», вердикт fix).
 */
async function liveOrWarn(
  io: StatusIo,
  window: DayWindow,
  cardUrl: (cardId: number) => string,
): Promise<readonly CardMove[]> {
  try {
    const access = requireKaitenAccess(io.envFile);
    return await liveMoves(kaitenSource(access), {
      window,
      cardUrl,
      warn: (line) => io.progress(line),
    });
  } catch (err) {
    // Только отказ Kaiten: дефект самого кода не выдаётся за отказ
    // внешней системы. Всё своё транспорт заворачивает в `KaitenError`,
    // включая ненастроенный ключ и сетевой отказ.
    if (!(err instanceof KaitenError)) throw err;
    io.progress(liveSkippedWarning(err));
    return [];
  }
}

/** Каталоги Kaiten в форме, которую знает сбор. */
function kaitenSource(access: KaitenAccess): LiveSource {
  return {
    currentUserId: async () => (await getCurrentUser(access)).id,
    cardsUpdated: async (memberId, window) =>
      (await listCards(access, {
        memberIds: [memberId],
        updatedAfter: window.fromIso,
        updatedBefore: window.toIso,
      })).map((card) => ({
        id: card.id,
        title: card.title,
        boardId: card.boardId,
      })),
    cardHistory: (cardId) => listCardLocationHistory(access, cardId),
    boardColumns: (boardId) => listBoardColumns(access, boardId),
  };
}

/**
 * Отправка отчёта: один вызов — один сеанс, он закрывается в любом
 * исходе. Усечение — свойство отправки: в stdout уходит полный текст.
 */
async function send(
  io: StatusIo,
  target: TargetPeer,
  text: string,
): Promise<SentView> {
  const config = telegramConfig(io.envFile);
  const { openSession } = await import("./session.ts");
  const session = await openSession(config);
  try {
    const sent = await sendMessage(session, {
      target: target.target,
      peer: target.peer,
      text: cutToLimit(text, MESSAGE_LIMIT),
      markdown: true,
      attachments: [],
    });
    return { id: sent.id, chat_id: sent.chatId, date: sent.date };
  } finally {
    // Отказ закрытия глушится: соединение уходит вместе с процессом, а
    // бросок отсюда подменил бы собой отказ самой отправки.
    await session.close().catch(() => {});
  }
}

export const telegramStatusCommand = defineCommand({
  path: ["telegram", "status"],
  errorName: "telegram status",
  summary: "Отправить отчёт о сегодняшних перемещениях карточек.",
  usage: "mpu telegram status [--chat X] [--no-live] [--dry-run]",
  help: `Отчёт за сегодня (день МСК): какие карточки Kaiten я двигал и
куда. Источники — журнал перемещений (его пишут команды mpu kiten) и
живой опрос Kaiten.

--chat X — адресат: me («Избранное»), id, @username, ссылка t.me,
телефон или название чата. Не задан — берётся TELEGRAM_DEFAULT_CHAT.
--no-live — не опрашивать Kaiten: отчёт на одном журнале.
--dry-run — напечатать отчёт в stdout и выйти: ни адресат, ни Telegram
не нужны; Kaiten опрашивается и здесь.

Отказ Kaiten, ненастроенный KITEN_API_KEY или недоступная история
карточки — строка в stderr и код 0: отчёт строится на журнале.

Отправка необратима и уходит от твоего имени; для проверок бери me.
Текст длиннее 4096 символов усекается по границе целых строк, --dry-run
печатает его целиком.

stdout — текст отчёта при --dry-run, иначе строка JSON отправки.

Ключи env-файла: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION
(обязательны), TELEGRAM_DEFAULT_CHAT, TELEGRAM_PROXY, KITEN_API_KEY,
KITEN_BASE_URL, KITEN_COLUMN_MAP, KITEN_STATUS_EMOJI.

Exit: 1 — конфигурация или отказ Telegram; 2 — адресат не задан.

Пример: mpu telegram status --dry-run --no-live`,
  policy: "rw",
  argsSchema,
  resultSchema,
  run: runTelegramStatus,
  render: (result) =>
    result.sent === null ? `${result.text}\n` : renderSent(result.sent),
});
