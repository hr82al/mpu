/**
 * Команда `mpu move-client-back` (`docs/specs/move-client-back.md`):
 * реверс переноса и управление журналом ходов.
 *
 * Направление реверс берёт ТОЛЬКО из журнала. Это единственное место
 * семейства, где команда решает сама, а не пробрасывает чужой код, — и
 * решает она отказом: угадывать, откуда клиент приехал, значит рисковать
 * увести его туда, где его нет.
 *
 * Коды выхода у отказов разные намеренно. Реверс без записи — ошибка
 * ввода (exit 2): оператор просит сделать то, чего команда не знает как.
 * `rm` без записи — успех (exit 0): удалять нечего, а идемпотентность
 * важнее симметрии кодов (тот же приём, что у `mpu config --unset`).
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  UsageError,
} from "../command/mod.ts";
import {
  type CacheReader,
  requireSingleClient,
  resolveSelector,
} from "../selector/mod.ts";
import { forgetMove, type Move, moveOf, moves } from "./journal.ts";
import {
  putJob,
  serverNumberOf,
  type TransferIo,
  type TransferOptions,
} from "./transfer.ts";

/** Слова диспетчера; клиент с таким именем адресуем только числом. */
const LIST_WORDS = ["ls", "list"];
const RM_WORD = "rm";

const argsSchema = z.object({
  selector: z.string().optional().describe(
    "селектор клиента, либо ls | rm <селектор>",
  ),
  target: z.string().optional().describe("селектор для формы rm"),
});

const moveSchema = z.object({
  client_id: z.number(),
  source: z.string(),
  target: z.string(),
  moved_at: z.number(),
});

const resultSchema = z.object({
  action: z.enum(["revert", "ls", "rm"]),
  moves: z.array(moveSchema).describe("записи журнала: у ls — все"),
  removed: z.boolean().describe("была ли удалена запись"),
  exitCode: z.number().int().describe("код постановки задачи; иначе 0"),
});

type BackArgs = z.infer<typeof argsSchema>;
type BackResult = z.infer<typeof resultSchema>;

/** Порт: тот же, что у прямой команды. */
export type BackIo = TransferIo & Pick<CommandIo, "openCacheDb">;

/** Подстановки для тестов. */
export type BackOptions = TransferOptions;

/** Запись журнала в форме результата. */
function moveRow(move: Move) {
  return {
    client_id: move.clientId,
    source: move.source,
    target: move.target,
    moved_at: move.movedAt,
  };
}

/**
 * client_id селектора. Чистое число трактуется как client_id напрямую,
 * минуя кэш: журнал ходов переживает непрогретый кэш, и реверс не
 * должен от него зависеть (спека).
 */
function clientIdOf(io: BackIo, db: CacheDb, selector: string): number {
  if (/^\d+$/.test(selector.trim())) return Number(selector.trim());
  const cache: CacheReader = {
    query: (sql, ...params) => db.query(sql, ...params),
  };
  return requireSingleClient(
    resolveSelector({ cache, env: io.envFile }, selector),
  );
}

/** Ход вызова: диспетчер по первому аргументу. */
export async function runMoveClientBack(
  args: BackArgs,
  io: BackIo,
  options: BackOptions = {},
): Promise<BackResult> {
  using db = io.openCacheDb();
  const first = args.selector?.trim();

  if (first === undefined || LIST_WORDS.includes(first)) {
    return {
      action: "ls",
      moves: moves(db).map(moveRow),
      removed: false,
      exitCode: 0,
    };
  }

  if (first === RM_WORD) {
    if (args.target === undefined) {
      throw new UsageError("`rm` требует селектор (rm <selector>)");
    }
    const clientId = clientIdOf(io, db, args.target);
    const move = moveOf(db, clientId);
    const removed = forgetMove(db, clientId);
    if (!removed) {
      // Удалять нечего — это успех, а не отказ: повторный `rm` обязан
      // быть безобидным (идемпотентность, спека).
      // Префикс команды обязателен: сообщение об исходе идёт в том же
      // формате, что и отказы семейства (`mpu <команда>: <текст>`), —
      // голая строка в stderr выглядит чужой.
      io.progress(
        `mpu move-client-back: нет записи хода для client ${clientId}`,
      );
    }
    return {
      action: "rm",
      moves: move === undefined ? [] : [moveRow(move)],
      removed,
      exitCode: 0,
    };
  }

  return await revert(io, db, clientIdOf(io, db, first), options);
}

/** Реверс: направление из журнала, задача, удаление записи. */
async function revert(
  io: BackIo,
  db: CacheDb,
  clientId: number,
  options: BackOptions,
): Promise<BackResult> {
  const move = moveOf(db, clientId);
  if (move === undefined) {
    // Громкий отказ, а не догадка: журнал — единственный источник
    // направления, и «наверное, с sl-1» увело бы клиента не туда.
    throw new UsageError(
      `нет записанного хода для client ${clientId} ` +
        "(сначала `mpu move-client`, либо запусти `mpu init`)",
    );
  }
  const from = serverNumberOf(move.target);
  const to = serverNumberOf(move.source);
  if (from === undefined || to === undefined) {
    throw new UsageError(
      `повреждённая запись хода: ${move.source} → ${move.target}`,
    );
  }
  if (from === to) {
    throw new UsageError(
      `source и target записи оба sl-${from} — нечего возвращать`,
    );
  }
  io.progress(`возврат client ${clientId}: ${move.target} → ${move.source}`);
  const cache: CacheReader = {
    query: (sql, ...params) => db.query(sql, ...params),
  };
  // Направление обратное записи: возвращаем оттуда, куда переносили.
  const exitCode = await putJob(io, cache, {
    clientId,
    sourceServer: from,
    targetServer: to,
  }, options);
  // Запись снимается только после успешной постановки: иначе повторный
  // реверс потерял бы направление, а клиент остался бы на чужом
  // сервере (инвариант спеки).
  const removed = exitCode === 0 ? forgetMove(db, clientId) : false;
  return { action: "revert", moves: [moveRow(move)], removed, exitCode };
}

/** Локальное время записи в форме `YYYY-MM-DD HH:MM:SS`. */
function localTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())} ${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Вывод: таблица ходов у `ls`, строка про удаление у `rm`. */
export function renderMoveClientBack(result: BackResult): string {
  if (result.action === "ls") {
    if (result.moves.length === 0) return "нет записанных ходов\n";
    const head = "client_id\tперенос (откуда → куда)\tкогда\n";
    return head + result.moves
      .map((move) =>
        `${move.client_id}\t${move.source} → ${move.target}\t` +
        `${localTime(move.moved_at)}\n`
      )
      .join("");
  }
  if (result.action === "rm") {
    const move = result.moves[0];
    return result.removed && move !== undefined
      ? `запись удалена: client ${move.client_id}, ${move.source} → ` +
        `${move.target}\n`
      : "";
  }
  return "";
}

export const moveClientBackCommand = defineCommand({
  path: ["move-client-back"],
  errorName: "move-client-back",
  summary: "Вернуть клиента обратно и управлять журналом переносов.",
  usage: "mpu move-client-back [SELECTOR | ls | rm SELECTOR]",
  help: `Возвращает клиента туда, откуда его перенесла mpu move-client:
ставит обратную задачу переноса и снимает запись журнала. Направление
берётся только из журнала — если записи нет, команда отказывается, а не
угадывает: увести клиента не туда хуже, чем не сделать ничего.

Без аргументов или с ls печатает записанные ходы: клиент, маршрут и
время записи, новые сверху.

rm SELECTOR удаляет запись, ничего не перенося. Повторный rm — тоже
успех: удалять нечего.

Селектор из одних цифр читается как client_id напрямую, мимо кэша: ход
записан локально и переживает непрогретый кэш. Клиент, чей заголовок
буквально ls, rm или list, адресуется только числом — слова заняты.

Запись снимается лишь после успешной постановки задачи: иначе
повторный возврат потерял бы направление.

Exit: 0 — задача поставлена, ls и rm; 2 — нет записи хода, повреждённая
запись, rm без селектора, резолв селектора; иначе — код createJob.

Примеры: mpu move-client-back 1234; mpu move-client-back ls;
mpu move-client-back rm 1234`,
  policy: "rw",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    target: { positional: "one" },
  },
  resultSchema,
  run: (args: BackArgs, io: BackIo) => runMoveClientBack(args, io),
  render: (result: BackResult) => renderMoveClientBack(result),
  textExitCode: (result: BackResult) => result.exitCode,
});
