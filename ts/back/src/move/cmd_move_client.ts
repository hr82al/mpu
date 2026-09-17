/**
 * Команда `mpu move-client` (`docs/specs/move-client.md`): перенос
 * клиента между sl-серверами фермы.
 *
 * Команда не переносит данные — она ставит задачу в очередь и
 * записывает ход в журнал. Успех означает «задача поставлена», а не
 * «клиент переехал»: за исполнением следят воркеры, и команде они не
 * подчиняются.
 *
 * Ход записывается СТРОГО после нулевого кода постановки. Записать его
 * раньше значило бы научить реверс вести клиента оттуда, где его нет,
 * — единственный способ этой парой команд навредить по-настоящему.
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
import { recordMove } from "./journal.ts";
import {
  putJob,
  serverNumberOf,
  type TransferIo,
  type TransferOptions,
} from "./transfer.ts";

const argsSchema = z.object({
  selector: z.string({
    error: "нужен SELECTOR: client_id, spreadsheet_id или заголовок",
  }).describe("клиент: client_id, spreadsheet_id, заголовок таблицы"),
  target: z.string().default("sl-1").describe(
    "сервер назначения вида sl-N; по умолчанию sl-1",
  ),
});

const resultSchema = z.object({
  clientId: z.number(),
  source: z.string().describe("сервер, откуда переносим"),
  target: z.string().describe("сервер назначения"),
  exitCode: z.number().int().describe("код постановки задачи, 1:1"),
  recorded: z.boolean().describe("записан ли ход в журнал"),
});

type MoveArgs = z.infer<typeof argsSchema>;
type MoveResult = z.infer<typeof resultSchema>;

/** Порт: транспорт постановки плюс кэш-БД под журнал и резолв. */
export type MoveIo = TransferIo & Pick<CommandIo, "openCacheDb">;

/** Подстановки для тестов: живого контейнера и очереди нет. */
export type MoveOptions = TransferOptions;

/** Ход вызова: резолв, постановка задачи, запись хода. */
export async function runMoveClient(
  args: MoveArgs,
  io: MoveIo,
  options: MoveOptions = {},
): Promise<MoveResult> {
  const targetServer = serverNumberOf(args.target);
  if (targetServer === undefined) {
    throw new UsageError(`bad --target '${args.target}' (expected sl-N)`);
  }
  using db = io.openCacheDb();
  const cache: CacheReader = {
    query: (sql, ...params) => db.query(sql, ...params),
  };
  const resolved = resolveSelector({ cache, env: io.envFile }, args.selector);
  // Тексты отказов — платформенные: своя формулировка в каждой команде
  // разошлась бы с остальными на ровном месте.
  const clientId = requireSingleClient(resolved);
  const sourceServer = resolved.serverNumber;
  if (sourceServer === targetServer) {
    // Задача с source == target не ставится никогда: переносить нечего,
    // а очередь получила бы работу без смысла.
    throw new UsageError(
      `source и target оба sl-${sourceServer} — нечего переносить`,
    );
  }

  const exitCode = await putJob(io, cache, {
    clientId,
    sourceServer,
    targetServer,
  }, options);
  const source = `sl-${sourceServer}`;
  const target = `sl-${targetServer}`;
  if (exitCode !== 0) {
    // Ход не записан: задача не поставлена, и реверсу возвращать
    // нечего (инвариант спеки).
    return { clientId, source, target, exitCode, recorded: false };
  }
  const recorded = writeMove(io, db, clientId, source, target);
  return { clientId, source, target, exitCode, recorded };
}

/**
 * Запись хода. Отказ записи не меняет кода выхода — задача уже
 * поставлена, — но предупреждение обязательно: без журнала реверс
 * станет невозможен, и оператор должен узнать об этом сразу, а не
 * когда попробует вернуть клиента (отклонение `fix` спеки).
 */
function writeMove(
  io: MoveIo,
  db: CacheDb,
  clientId: number,
  source: string,
  target: string,
): boolean {
  try {
    recordMove(db, {
      clientId,
      source,
      target,
      movedAt: Math.floor(Date.now() / 1000),
    });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "";
    io.progress(
      `mpu move-client: WARN ход не записан (${reason}); ` +
        `mpu move-client-back для client ${clientId} работать не будет`,
    );
    return false;
  }
}

/** stdout пуст: весь ход команды — служебные строки в stderr. */
export function renderMoveClient(): string {
  return "";
}

export const moveClientCommand = defineCommand({
  path: ["move-client"],
  errorName: "move-client",
  summary: "Перенести клиента на другой sl-сервер фермы.",
  usage: "mpu move-client SELECTOR [--target sl-N]",
  help: `Ставит задачу переноса клиента между серверами фермы: запускает
clientsTransfer createJob в контейнере mp-dt-cli. Сам перенос выполняют
воркеры очереди, и команда за ним не следит — её успех означает, что
задача поставлена.

SELECTOR — client_id, подстрока spreadsheet_id или заголовка; сервер
источника берётся из резолва. --target — сервер назначения вида sl-N,
по умолчанию sl-1. Совпадение источника и назначения — ошибка ввода:
переносить нечего.

Перенос всегда идёт с --destroy: это move, а не копия. Без него клиент
остался бы на обоих серверах.

После успешной постановки команда записывает ход «откуда → куда» в
локальный журнал — это единственный источник направления для
mpu move-client-back. Если запись не удалась, команда предупреждает:
задача уже поставлена, но вернуть клиента обратной командой не выйдет.

Exit: 0 — задача поставлена; 2 — резолв селектора, --target не вида
sl-N, совпадение источника и назначения, нерезолвящийся контейнер; иначе
— код createJob как есть.

Примеры: mpu move-client 1234 --target sl-4; mpu move-client 'магазин'`,
  policy: "rw",
  argsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: (args: MoveArgs, io: MoveIo) => runMoveClient(args, io),
  render: () => renderMoveClient(),
  textExitCode: (result: MoveResult) => result.exitCode,
});
