/**
 * Границы команды `logs` с внешним миром: чтение записей из Loki,
 * снимок логов контейнера через Portainer и поток печати. Объявлены на
 * стороне потребителя и ровно тем минимумом, который команда зовёт, —
 * в тестах на их место встаёт ручной фейк, и сети там нет вовсе.
 *
 * Реализации поверх атомов лежат здесь же: они тонкие (адрес, вызов,
 * разбор ответа сделаны атомами) и нужны только команде.
 */

import type { LogEntry, LokiAccess, RangeQuery } from "../loki/mod.ts";
import { queryRange } from "../loki/mod.ts";
import type {
  ContainerLogsQuery,
  DockerStreams,
  PortainerAccess,
} from "../portainer/mod.ts";
import {
  demuxDockerStream,
  fetchContainerLogs,
  listContainers,
} from "../portainer/mod.ts";

/** Чтение записей окна из Loki. */
export type ReadLoki = (
  access: LokiAccess,
  query: RangeQuery,
) => Promise<readonly LogEntry[]>;

/** Имена контейнеров environment'а Portainer, без ведущего `/`. */
export type ListContainerNames = (
  access: PortainerAccess,
  endpointId: number,
) => Promise<readonly string[]>;

/** Снимок логов контейнера, уже разобранный на потоки. */
export type ReadContainerLogs = (
  access: PortainerAccess,
  endpointId: number,
  container: string,
  query: ContainerLogsQuery,
) => Promise<DockerStreams>;

/**
 * Куда команда пишет поток логов. Нужен там, где вывод не выражается
 * результатом команды: слежение печатает записи по мере поступления, а
 * снимок Portainer несёт stderr-часть, которой в рендере места нет
 * (`platform/command-contract.md` знает один канал — stdout рендера).
 */
export interface LogStream {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * Реализация `ReadLoki` поверх `queryRange`: те же входы и результат, без
 * добавленного поведения. Отличие от типа порта — `queryRange` умеет
 * принимать свои пределы времени третьим параметром, здесь он всегда
 * зовётся с умолчанием (`DEFAULT_TIMEOUTS`), потому что порт места под
 * переопределение не оставляет.
 */
export const readLokiOverHttp: ReadLoki = (access, query) =>
  queryRange(access, query);

/**
 * Реализация `ListContainerNames` поверх `listContainers`: в отличие от
 * типа порта, отдающего одно имя на контейнер, у Docker контейнер может
 * иметь несколько имён (алиасы docker-compose) — они разворачиваются в
 * плоский список, и у каждого снимается ведущий `/`.
 */
export const listContainerNamesOverHttp: ListContainerNames = async (
  access,
  endpointId,
) => {
  const containers = await listContainers(access, endpointId);
  return containers.flatMap((container) =>
    container.names.map((name) => name.replace(/^\//, ""))
  );
};

/**
 * Реализация `ReadContainerLogs` поверх `fetchContainerLogs` +
 * `demuxDockerStream`: тип порта отдаёт готовые потоки, а сеть возвращает
 * один мультиплексированный байтовый снимок — разбор на stdout/stderr
 * сделан здесь же, вторым шагом.
 */
export const readContainerLogsOverHttp: ReadContainerLogs = async (
  access,
  endpointId,
  container,
  query,
) =>
  demuxDockerStream(
    await fetchContainerLogs(access, endpointId, container, query),
  );

/**
 * Поток процесса: данные в stdout, диагностика в stderr. Запись
 * синхронная — слежение печатает записи по мере поступления, и
 * отложенная запись перепутала бы их порядок с диагностикой.
 */
export function processStream(): LogStream {
  const encoder = new TextEncoder();
  return {
    out: (text) => void Deno.stdout.writeSync(encoder.encode(text)),
    err: (text) => void Deno.stderr.writeSync(encoder.encode(text)),
  };
}

/**
 * Пауза между опросами слежения, прерываемая сигналом остановки. Уже
 * взведённый сигнал возвращает управление сразу: подписка на событие
 * `abort` его не увидит — оно уже случилось.
 */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
