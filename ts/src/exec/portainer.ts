/**
 * Portainer-бэкенд транспорта (`platform/exec-transport.md`,
 * «Portainer-путь»): доставка stdin архивом, создание exec'а, стрим
 * вывода по WebSocket, чтение кода выхода, kill при Ctrl+C и уборка
 * временных файлов.
 *
 * Порядок шагов — контракт границы, а не деталь: pidfile пишется тем же
 * exec'ом, что и команда, иначе убивать при Ctrl+C было бы некого, а
 * уборка идёт всегда, включая ошибочный путь.
 */

import { type HttpResponse, httpSend, type SendOptions } from "../http/mod.ts";
import type { RemoteOutput } from "../command/mod.ts";
import { DomainError } from "../command/mod.ts";
import { quoteArg, shellCommand } from "./shell.ts";
import type { ExecTarget } from "./target.ts";
import { tarFile } from "./tar.ts";
import { type OpenChannel, streamWebSocket } from "./ws.ts";

/** Файлы вызова в `/tmp` контейнера (спека, пп. 2-3). */
const STDIN_FILE = "__MPU_PSSH_STDIN";
const STDIN_PATH = `/tmp/${STDIN_FILE}`;
const PID_PATH = "/tmp/__MPU_PSSH_PID";

/** Сколько всего ждать код выхода, пока exec ещё выполняется (спека, п. 6). */
const EXIT_WAIT_MS = 2_000;
const EXIT_STEP_MS = 200;

/** Portainer-таргет: бэкенд другого не принимает. */
export type PortainerTarget = Extract<ExecTarget, { kind: "portainer" }>;

/** HTTP-вызов Portainer; подменяется в тестах бэкенда. */
export type HttpCall = (
  url: URL,
  options: SendOptions & { readonly insecure?: boolean },
) => Promise<HttpResponse>;

/** Подписка на Ctrl+C; возвращает отписку. */
export type OnInterrupt = (handler: () => void) => () => void;

/** Что нужно Portainer-бэкенду для одного прогона. */
export interface PortainerRun {
  readonly target: PortainerTarget;
  readonly command: readonly [string, ...string[]];
  readonly stdin: Uint8Array;
  readonly output: RemoteOutput;
  /** Диагностика хода вызова: точка входа печатает её в stderr. */
  readonly warn: (line: string) => void;
  readonly http?: HttpCall;
  readonly open?: OpenChannel;
  readonly onInterrupt?: OnInterrupt;
  /** Пауза между опросами кода выхода; в тестах — мгновенная. */
  readonly delay?: (ms: number) => Promise<void>;
}

/** Код выхода удалённой команды. */
export async function runOverPortainer(run: PortainerRun): Promise<number> {
  const call = callOf(run);
  const withStdin = run.stdin.length > 0;
  try {
    if (withStdin) await uploadStdin(call, run);
    const id = await createExec(call, wrapped(run.command, withStdin));
    return await streamAndWait(call, run, id);
  } finally {
    // Уборка идёт всегда: после ошибки, после Ctrl+C и после отказа
    // на полпути — иначе доставленный stdin остался бы лежать в
    // контейнере (спека, п. 8). Её собственный отказ на код выхода не
    // влияет.
    await cleanup(call, withStdin).catch(() => {});
  }
}

/**
 * Стрим вывода и код выхода. Ctrl+C во время стрима убивает удалённый
 * процесс явно: разрыв WebSocket'а Docker не замечает и оставляет
 * команду работать (спека, п. 7).
 */
async function streamAndWait(
  call: ExecCall,
  run: PortainerRun,
  id: string,
): Promise<number> {
  const controller = new AbortController();
  let interrupted = false;
  const off = (run.onInterrupt ?? denoInterrupt)(() => {
    interrupted = true;
    run.warn("mpu: Ctrl+C → killing remote process...");
    controller.abort();
  });
  try {
    await call.stream(id, run.output.out, controller.signal);
  } catch (err) {
    // Прерванный стрим вправе закончиться и отказом сокета — kill
    // всё равно обязателен, иначе удалённая команда переживёт вызов.
    if (!interrupted) throw err;
  } finally {
    off();
    if (interrupted) await killRemote(call).catch(() => {});
  }
  // Локальный код выхода после прерывания контрактом не назван (спека,
  // п. 7): спрашивать его у оборванного exec'а нечего.
  return interrupted ? 130 : await exitCode(call, run, id);
}

/**
 * Код выхода exec'а. `null` значит «ещё выполняется»: медленно
 * завершающийся exec не объявляется упавшим сразу (отклонение `fix`
 * спеки), но и ждать его вечно нельзя.
 */
async function exitCode(
  call: ExecCall,
  run: PortainerRun,
  id: string,
): Promise<number> {
  const delay = run.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0;; waited += EXIT_STEP_MS) {
    const code = await inspectExec(call, id);
    if (code !== null) return code;
    if (waited >= EXIT_WAIT_MS) break;
    await delay(EXIT_STEP_MS);
  }
  run.warn(
    "mpu: код выхода удалённой команды неизвестен: exec ещё выполняется",
  );
  return 1;
}

/** Обёртка команды: pidfile пишется до неё, дальше — `exec` (спека, п. 3). */
function wrapped(
  command: readonly [string, ...string[]],
  withStdin: boolean,
): readonly string[] {
  const shell = withStdin
    ? `${shellCommand(command)} < ${STDIN_PATH}`
    : shellCommand(command);
  return ["sh", "-c", `echo $$ > ${PID_PATH}; exec sh -c ${quoteArg(shell)}`];
}

/** Границы Portainer одним объектом: адреса и заголовки собраны один раз. */
interface ExecCall {
  readonly container: string;
  readonly send: (
    path: string,
    options: SendOptions & { readonly insecure?: boolean },
  ) => Promise<HttpResponse>;
  readonly stream: (
    id: string,
    onData: (chunk: Uint8Array) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
}

function callOf(run: PortainerRun): ExecCall {
  const { access, endpointId } = run.target;
  const http = run.http ?? httpSend;
  const headers = { "X-API-Key": access.apiKey };
  const insecure = !access.verifyTls;
  return {
    container: run.target.container,
    send: (path, options) =>
      http(
        new URL(`${access.baseUrl}/api/endpoints/${endpointId}/docker${path}`),
        {
          ...options,
          headers: { ...headers, ...options.headers },
          insecure,
        },
      ),
    stream: (id, onData, signal) =>
      streamWebSocket({
        url: new URL(
          `${access.baseUrl}/api/websocket/exec?id=${id}&endpointId=${endpointId}`,
        ),
        headers,
        insecure,
        onData,
        signal,
        open: run.open,
      }),
  };
}

/** Доставка stdin файлом в `/tmp` контейнера (спека, п. 2). */
async function uploadStdin(call: ExecCall, run: PortainerRun): Promise<void> {
  const response = await call.send(
    `/containers/${call.container}/archive?path=/tmp`,
    {
      method: "PUT",
      body: tarFile(STDIN_FILE, run.stdin),
      headers: { "Content-Type": "application/x-tar" },
    },
  );
  requireOk(response, "доставка stdin");
}

async function createExec(
  call: ExecCall,
  cmd: readonly string[],
): Promise<string> {
  const response = await call.send(`/containers/${call.container}/exec`, {
    method: "POST",
    body: JSON.stringify({
      AttachStdout: true,
      AttachStderr: true,
      // Tty сливает stdout и stderr в один поток; без него Node в
      // контейнере буферизует вывод пакетами и стрима не выходит
      // (отклонение `preserve` спеки).
      Tty: true,
      Cmd: [...cmd],
    }),
    headers: { "Content-Type": "application/json" },
  });
  requireOk(response, "создание exec");
  const id = parsed(response.text)?.Id;
  if (typeof id !== "string" || id === "") {
    throw new DomainError("Portainer не вернул идентификатор exec'а");
  }
  return id;
}

/**
 * Код выхода или `null`, если exec ещё выполняется. Ответ без поля
 * `ExitCode` — не «ещё выполняется», а сломанная граница: повторять
 * такой опрос десять раз значит ждать две секунды заведомо зря.
 */
async function inspectExec(call: ExecCall, id: string): Promise<number | null> {
  const response = await call.send(`/exec/${id}/json`, {});
  requireOk(response, "чтение кода выхода");
  const body = parsed(response.text);
  const code = body === null ? undefined : body.ExitCode;
  if (code === null) return null;
  if (typeof code !== "number") {
    throw new DomainError(
      "чтение кода выхода: в ответе Portainer нет ExitCode",
    );
  }
  return code;
}

/**
 * Убийство удалённого процесса по pidfile. Пауза между сигналами —
 * удалённая: локальный сон здесь ничего бы не ждал, а вызов уже
 * оборван.
 */
function killRemote(call: ExecCall): Promise<void> {
  return silentExec(
    call,
    `pid=$(cat ${PID_PATH} 2>/dev/null); [ -n "$pid" ] || exit 0;` +
      ' kill -INT "$pid"; sleep 1; kill -KILL "$pid"',
  );
}

function cleanup(call: ExecCall, withStdin: boolean): Promise<void> {
  const files = withStdin ? `${PID_PATH} ${STDIN_PATH}` : PID_PATH;
  return silentExec(call, `rm -f ${files}`);
}

/** Служебный exec: вывод не нужен, отказ на код выхода не влияет. */
async function silentExec(call: ExecCall, script: string): Promise<void> {
  const id = await createExec(call, ["sh", "-c", script]);
  await call.stream(id, () => {});
}

function requireOk(response: HttpResponse, what: string): void {
  if (response.status >= 200 && response.status < 300) return;
  throw new DomainError(`${what}: Portainer ответил ${response.status}`);
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : null;
  } catch {
    // Не JSON — для вызывающего то же самое, что ответ без нужного поля.
    return null;
  }
}

/** Подписка на Ctrl+C поверх сигналов процесса. */
const denoInterrupt: OnInterrupt = (handler) => {
  Deno.addSignalListener("SIGINT", handler);
  return () => Deno.removeSignalListener("SIGINT", handler);
};
