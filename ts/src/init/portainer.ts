/**
 * HTTP-клиент Portainer API (`docs/specs/init.md`, шаг 2): список
 * environment'ов и список контейнеров внутри одного из них. Модуль не
 * знает о командах, кэш-БД или конфигурации — только о протоколе
 * Portainer/Docker и о том, как ограничить один вызов по времени.
 */

import { Buffer } from "node:buffer";
import { request as httpsRequest } from "node:https";

/** Таймаут ожидания заголовков ответа; часы видны в `--help` init. */
export const HEADERS_TIMEOUT_MS = 3_000;
/** Таймаут всего вызова, включая чтение тела; часы видны в `--help` init. */
export const TOTAL_TIMEOUT_MS = 10_000;

/** Environment Portainer: пара (base_url, id) адресует Docker API сервера. */
export interface PortainerEndpoint {
  readonly id: number;
  readonly name: string;
}

/** Контейнер Docker внутри одного endpoint'а, как его отдаёт `/containers/json`. */
export interface PortainerContainer {
  readonly id: string;
  readonly names: readonly string[];
  readonly state: string;
  readonly image: string;
}

/** Подключение к Portainer API. */
export interface PortainerAccess {
  /** Без хвостовых `/` — нормализация делается до вызова клиента. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /**
   * `false` отключает проверку TLS-сертификата (`PORTAINER_VERIFY_TLS`,
   * `init.md`). Применимо только к `https:` — `http:` его не читает.
   */
  readonly verifyTls: boolean;
}

/**
 * Сбой обращения к Portainer API: сеть, таймаут одного из двух
 * пределов, HTTP-код вне 2xx. Причина — всегда одной строкой (первая
 * строка исходного сообщения): у нижележащих ошибок `fetch` бывает
 * многострочное сообщение со второй строкой-подсказкой, а `init.md`
 * печатает причину в stderr одной строкой (вердикт fix спеки).
 */
export class PortainerError extends Error {
  override name = "PortainerError";
}

/** Оба предела одного вызова — параметр, не всегда константа: см. `fetchPortainerJson`. */
export interface RequestTimeouts {
  readonly headersTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

/** Пределы по умолчанию: их числа названы в `--help` команды init. */
export const DEFAULT_TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: HEADERS_TIMEOUT_MS,
  totalTimeoutMs: TOTAL_TIMEOUT_MS,
};

/** Форма `/api/endpoints` — берутся только используемые поля. */
interface RawEndpoint {
  readonly Id: number;
  readonly Name: string;
}

/** Форма элемента `/containers/json` — берутся только используемые поля. */
interface RawContainer {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly State: string;
  readonly Image: string;
}

export async function listEndpoints(
  access: PortainerAccess,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<readonly PortainerEndpoint[]> {
  const raw = await fetchPortainerJson<readonly RawEndpoint[]>(
    access,
    "/api/endpoints",
    timeouts,
  );
  return raw.map((e) => ({ id: e.Id, name: e.Name }));
}

export async function listContainers(
  access: PortainerAccess,
  endpointId: number,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<readonly PortainerContainer[]> {
  const raw = await fetchPortainerJson<readonly RawContainer[]>(
    access,
    `/api/endpoints/${endpointId}/docker/containers/json?all=true`,
    timeouts,
  );
  return raw.map((c) => ({
    id: c.Id,
    names: c.Names,
    state: c.State,
    image: c.Image,
  }));
}

/**
 * GET на путь Portainer API, разобранный как JSON. Пределы вызова —
 * параметр со значением по умолчанию, а не константа внутри: тест
 * молчащего сервера обязан укладываться в доли секунды, а не ждать
 * реальные три секунды продуктового предела (`ts/CLAUDE.md`: сон стеной
 * в тестах запрещён). Тем же швом пользуется тест молчащего endpoint'а
 * на уровне команды — через `runInit`.
 *
 * Один `AbortController` держит два таймера: `headersTimeoutMs` до
 * получения заголовков ответа, `totalTimeoutMs` на весь вызов вместе с
 * чтением тела. Таймер заголовков снимается сразу, как заголовки
 * пришли, — дальше вызов ограничен только общим пределом. Вызова без
 * таймаута не существует: оба параметра обязательны.
 */
export async function fetchPortainerJson<T>(
  access: PortainerAccess,
  path: string,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<T> {
  const url = new URL(`${access.baseUrl}${path}`);
  const controller = new AbortController();
  // Какой из двух таймеров сработал — читается в catch, чтобы причина
  // ошибки называла свой предел, а не общий текст AbortError у fetch и
  // node:https ("The operation was aborted" — не годится как причина).
  let timeoutMessage: string | undefined;
  const headersTimer = setTimeout(() => {
    timeoutMessage =
      `no response headers within ${timeouts.headersTimeoutMs}ms`;
    controller.abort();
  }, timeouts.headersTimeoutMs);
  const totalTimer = setTimeout(() => {
    timeoutMessage = `no response within ${timeouts.totalTimeoutMs}ms`;
    controller.abort();
  }, timeouts.totalTimeoutMs);
  try {
    const { status, text } = await send(
      url,
      { "X-API-Key": access.apiKey },
      access.verifyTls,
      controller.signal,
      () => clearTimeout(headersTimer),
    );
    if (status < 200 || status >= 300) {
      // Текст `HTTP <код>` — дословный формат проекта реализации (раздел
      // «Клиент Portainer»), не общий стиль ошибок проекта (там — с
      // маленькой буквы): `HTTP` здесь имя протокола, а не первое слово
      // предложения, как и заглавная буква в аналогичном исключении
      // `env/mod.ts` (`require`, комментарий рядом).
      throw new PortainerError(`HTTP ${status}`);
    }
    // Форма ответа фиксирована протоколом Portainer/Docker (`init.md`,
    // шаг 2): поля берутся по контракту внешней системы, а не заново
    // валидируются здесь — рантайм-схема на два эндпоинта добавила бы
    // ветки, которые нечем проверить (YAGNI), не приблизив к задаче.
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof PortainerError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PortainerError(timeoutMessage ?? firstLine(message), {
      cause: err,
    });
  } finally {
    clearTimeout(headersTimer);
    clearTimeout(totalTimer);
  }
}

/**
 * Первая строка сообщения об ошибке. Экспортирована для прямого теста
 * многострочного случая: у `fetch` он воспроизводим не в каждой среде
 * (в этом дереве не увиделся живьём ни разу — см. `portainer_test.ts`),
 * а инвариант «причина одной строкой» обязан быть проверен собственным
 * тестом, а не только косвенно через happy path.
 */
export function firstLine(message: string): string {
  const end = message.indexOf("\n");
  return end === -1 ? message : message.slice(0, end);
}

interface HttpResult {
  readonly status: number;
  readonly text: string;
}

/**
 * Транспорт запроса: `fetch` во всех случаях, кроме отключённой
 * проверки TLS на `https:` — там у Deno нет клиентской опции, гасящей
 * проверку сертификата (`Deno.createHttpClient` её не имеет,
 * `NODE_TLS_REJECT_UNAUTHORIZED` на `fetch` не влияет — проверено в
 * этом дереве). Единственный работающий путь — `node:https` с
 * `rejectUnauthorized: false`. `http:` эту развилку не читает вовсе:
 * проверять там нечего.
 */
async function send(
  url: URL,
  headers: Readonly<Record<string, string>>,
  verifyTls: boolean,
  signal: AbortSignal,
  onHeaders: () => void,
): Promise<HttpResult> {
  if (url.protocol === "https:" && !verifyTls) {
    return await sendInsecure(url, headers, signal, onHeaders);
  }
  const response = await fetch(url, { headers, signal });
  onHeaders();
  return { status: response.status, text: await response.text() };
}

function sendInsecure(
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  onHeaders: () => void,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        rejectUnauthorized: false,
        signal,
      },
      (res) => {
        onHeaders();
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            // `statusCode` типизирован `number | undefined`, потому что
            // `IncomingMessage` общий для клиента и сервера (у серверного
            // запроса его нет); здесь ответ всегда клиентский, и к
            // моменту события `end` статус уже разобран.
            status: res.statusCode!,
            text: Buffer.concat(chunks).toString("utf-8"),
          }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
