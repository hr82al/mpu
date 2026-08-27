/**
 * Постановка задачи переноса (`move-client.md`, «Побочные эффекты»):
 * `node cli service:clientsTransfer createJob …` в контейнере
 * `mp-dt-cli`.
 *
 * Команда отвечает за постановку, а не за перенос: задача ложится в
 * очередь BullMQ, а исполняют её отдельные воркеры. Поэтому здесь
 * наблюдаемого ровно два — собранная команда и код дочернего процесса;
 * всё, что происходит после, команде не подчиняется.
 *
 * `--destroy` передаётся всегда: это move, а не copy. Без него клиент
 * остался бы на обоих серверах, и «перенос» стал бы тихим удвоением.
 */

import { type CommandIo, UsageError } from "../command/mod.ts";
import {
  ambiguous,
  chooseTransport,
  containerLocations,
  type HttpCall,
  type OpenChannel,
  runOverPortainer,
  runOverSsh,
  type RunProcess,
} from "../exec/mod.ts";
import type { CacheReader } from "../selector/mod.ts";
import type { ExecPlace } from "../exec/mod.ts";
import { innerTokens } from "../nodecli/inner.ts";

/** Контейнер, где живёт cli переносов. */
export const TRANSFER_CONTAINER = "mp-dt-cli";

/** Срез порта: env-файл, приёмник вывода и печать хода. */
export type TransferIo = Pick<
  CommandIo,
  "env" | "envFile" | "openRemoteOutput" | "progress"
>;

/** Подстановки для тестов: живого контейнера у них нет. */
export interface TransferOptions {
  readonly runProcess?: RunProcess;
  readonly httpCall?: HttpCall;
  readonly openChannel?: OpenChannel;
}

/** Куда и кого переносим. */
export interface TransferJob {
  readonly clientId: number;
  readonly sourceServer: number;
  readonly targetServer: number;
}

/** Токены команды постановки; порядок флагов — контракт cli. */
export function transferCommand(
  job: TransferJob,
): readonly [string, ...string[]] {
  const tokens = innerTokens({
    service: "clientsTransfer",
    method: "createJob",
    flags: [
      { name: "source", value: `sl-${job.sourceServer}` },
      { name: "target", value: `sl-${job.targetServer}` },
      { name: "client-id", value: job.clientId },
      // Флаг без значения: `--destroy` — это move.
      { name: "destroy", value: true },
    ],
  });
  return [tokens[0], ...tokens.slice(1)] as [string, ...string[]];
}

/** Ключ ssh — тот же, что у транспорта (`platform/exec-transport.md`). */
const KEY_FILE = ".ssh/id_rsa";

/**
 * Путь ключа: домашний каталог оператора плюс имя файла. Без HOME —
 * отказ ввода, а не буквальная тильда: шелла в ssh-вызове нет, и
 * `~/.ssh/id_rsa` ушёл бы как имя файла, дав невнятный отказ ssh
 * вместо понятного нашего (та же проверка, что у обёрток `nodecli`).
 */
function keyPath(io: TransferIo): string {
  const home = io.env("HOME");
  if (home === undefined || home === "") {
    throw new UsageError("HOME не задан: неоткуда взять ssh-ключ");
  }
  return `${home}/${KEY_FILE}`;
}

/**
 * Контейнер переносов в Portainer-кэше. Резолв строгий, а не через
 * общий `placeOf`: тот, не найдя имени, уходит искать клиента, и
 * заголовок, содержащий `mp-dt-cli`, увёл бы задачу в cli-контейнер
 * обычного sl-сервера. Здесь имя константное, и «не нашли» означает
 * ровно одно — кэш не прогрет.
 */
function transferPlace(cache: CacheReader): ExecPlace {
  const found = containerLocations(cache, TRANSFER_CONTAINER);
  if (found.length === 1) return { kind: "container", location: found[0] };
  if (found.length > 1) throw ambiguous(TRANSFER_CONTAINER, found);
  throw new UsageError(
    `контейнер ${TRANSFER_CONTAINER} не найден в кэше Portainer`,
    { hint: "запусти `mpu init` для обновления Portainer-кэша" },
  );
}

/**
 * Ставит задачу и возвращает код дочернего процесса как есть. Код —
 * единственное, чем команда отвечает за исход: свои сообщения поверх
 * чужого отказа мешали бы читать причину.
 */
export async function putJob(
  io: TransferIo,
  cache: CacheReader,
  job: TransferJob,
  options: TransferOptions = {},
): Promise<number> {
  const command = transferCommand(job);
  io.progress(`$ ${command.join(" ")}  (in ${TRANSFER_CONTAINER})`);
  const place = transferPlace(cache);
  const target = chooseTransport({ place, env: io.envFile, cache });
  const output = io.openRemoteOutput();
  return target.kind === "ssh"
    ? await runOverSsh({
      target,
      command,
      stdin: new Uint8Array(),
      keyPath: keyPath(io),
      output,
      run: options.runProcess,
    })
    : await runOverPortainer({
      target,
      command,
      stdin: new Uint8Array(),
      output,
      warn: io.progress,
      http: options.httpCall,
      open: options.openChannel,
    });
}

/** Номер сервера из `sl-N`; иная форма — `undefined`. */
export function serverNumberOf(name: string): number | undefined {
  const match = /^sl-(\d+)$/.exec(name.trim());
  return match === null ? undefined : Number(match[1]);
}
