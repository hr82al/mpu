/**
 * Общая часть HTTP-вызовов внешних систем: один GET под двумя
 * пределами времени и причина отказа одной строкой. Шов один на трёх
 * клиентов — Portainer (`../portainer/mod.ts`), Loki (`../loki/mod.ts`)
 * и Kaiten (`../kaiten/mod.ts`), — поэтому пределы и отмена живут
 * здесь, а не переписываются в каждом.
 *
 * О самих протоколах модуль не знает: заголовки запроса, разбор тела и
 * трактовка кода ответа — дело клиента.
 *
 * Модуль вынесен из `src/init/`: это платформенный атом транспорта
 * (`docs/specs/platform/loki-http.md`), а не часть команды init, и с
 * появлением второго потребителя (`update`) импорт мимо `mod.ts`
 * нарушил бы границу модулей.
 */

import { Buffer } from "node:buffer";
import { request as httpsRequest } from "node:https";

/** Предел ожидания заголовков ответа; число видно в `--help` init. */
export const HEADERS_TIMEOUT_MS = 3_000;
/** Предел всего вызова, включая чтение тела; число видно в `--help` init. */
export const TOTAL_TIMEOUT_MS = 10_000;

/** Оба предела одного вызова — параметр, не всегда константа: см. `httpGet`. */
export interface RequestTimeouts {
  readonly headersTimeoutMs: number;
  /**
   * Предел всего вызова; `null` — предела нет. Отсутствие выражено
   * типом, а не огромным числом: `setTimeout` не принимает значений
   * шире int32 и молча схлопывает их в одну миллисекунду, то есть
   * «бесконечный» предел срабатывал бы мгновенно (`specs/health.md`:
   * у запроса логов предела чтения нет).
   */
  readonly totalTimeoutMs: number | null;
}

/**
 * Предел, шире которого таймер не работает: `setTimeout` принимает
 * int32 и молча схлопывает всё большее в одну миллисекунду. Значит,
 * «очень большое число» как способ сказать «предела нет» даёт ровно
 * обратное — мгновенный обрыв; сказать это можно только `null`.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** Пределы по умолчанию: их числа названы в `--help` команды init. */
export const DEFAULT_TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: HEADERS_TIMEOUT_MS,
  totalTimeoutMs: TOTAL_TIMEOUT_MS,
};

/**
 * Сбой самого вызова: сеть, разрыв, срабатывание одного из двух
 * пределов. Код ответа сбоем не считается — его трактует клиент, у
 * каждого своя форма сообщения (`init.md`, шаг 2; `kaiten-http.md`).
 *
 * Причина — всегда одной строкой (вердикт fix `init.md`): у ошибок
 * `fetch` бывает многострочное сообщение со второй строкой-подсказкой,
 * а спека печатает причину одной строкой.
 */
export class HttpCallError extends Error {
  override name = "HttpCallError";
}

/** Ответ как есть: код, тело текстом и заголовок паузы повтора. */
export interface HttpResponse {
  readonly status: number;
  readonly text: string;
  /** Значение `Retry-After` (контракт 429 Kaiten); заголовка нет — null. */
  readonly retryAfter: string | null;
}

/**
 * Тот же ответ телом-байтами: тело мультиплексированного потока Docker
 * (`docs/specs/logs.md`, portainer-путь) декодированию в текст не
 * подлежит — восьмибайтовые заголовки кадров несут произвольные байты
 * длины, и любой из них вне ASCII заменился бы символом-заменителем.
 */
export interface HttpBytesResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly retryAfter: string | null;
}

/** Что клиент добавляет к вызову сверх адреса. */
export interface GetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeouts?: RequestTimeouts;
  /**
   * Отключает проверку TLS-сертификата (`PORTAINER_VERIFY_TLS`,
   * `init.md`). Читается только для `https:` — у `http:` проверять
   * нечего.
   */
  readonly insecure?: boolean;
}

/** То же для вызова произвольным методом: тело формирует клиент. */
export interface SendOptions {
  /** Метод запроса; умолчание — `GET`. */
  readonly method?: string;
  /**
   * Готовое тело запроса; его тип объявляет клиент своим заголовком.
   * Байтами — тело, собранное клиентом самостоятельно
   * (`multipart/form-data` Kaiten несёт содержимое файлов, а оно текстом
   * не выражается). Параметр `ArrayBuffer` у `Uint8Array` выписан
   * явно: `fetch` принимает телом только неразделяемый буфер, и без
   * сужения `Uint8Array<ArrayBufferLike>` ему не подходит.
   */
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeouts?: RequestTimeouts;
  /**
   * Отключает проверку TLS-сертификата — то же, что у `GetOptions`, и
   * по той же причине: `PUT` архива и `POST` exec'а ходят в тот же
   * Portainer, что и читающие вызовы (`platform/exec-transport.md`).
   */
  readonly insecure?: boolean;
  /**
   * Прокси-URL для этого вызова; не задан — прямое соединение.
   * Параметром, а не переменной окружения: окружение слой не читает
   * (у собранного бинаря нет права), и адресность важна — прокси нужен
   * вызовам наружу (`api.telegram.org`, `docs/specs/telegram-log.md`),
   * а не обращениям к стенду, которые ходят напрямую.
   *
   * Схемы — те, что понимает клиент Deno: `http`, `https`, `socks5`,
   * `socks5h`. Пригодность значения проверяет вызывающий: у него есть
   * имя ключа, которым его настроили, и отказ он назовёт точнее.
   */
  readonly proxy?: string;
}

/**
 * GET по адресу под двумя пределами времени. Пределы — параметр со
 * значением по умолчанию, а не константа внутри: тест молчащего сервера
 * обязан укладываться в доли секунды, а не ждать реальные три секунды
 * продуктового предела (`ts/CLAUDE.md`: сон стеной в тестах запрещён).
 *
 * Один `AbortController` держит оба таймера: `headersTimeoutMs` до
 * получения заголовков ответа, `totalTimeoutMs` на весь вызов вместе с
 * чтением тела. Таймер заголовков снимается, как только заголовки
 * пришли, — дальше вызов ограничен только общим пределом. Вызова без
 * предела не существует: оба значения обязательны.
 *
 * Переменные прокси в вызове не участвуют: у собранного бинаря нет
 * права читать их (`deno.jsonc`, список `--allow-env`), поэтому
 * требование `platform/loki-http.md` выполнено по построению.
 */
export async function httpGet(
  url: URL,
  options: GetOptions = {},
): Promise<HttpResponse> {
  const response = await httpGetBytes(url, options);
  return {
    status: response.status,
    text: new TextDecoder().decode(response.bytes),
    retryAfter: response.retryAfter,
  };
}

/**
 * То же обращение с телом-байтами: пределы времени, отмена и форма
 * причины отказа общие с `httpGet`, разница только в том, что тело не
 * декодируется (см. `HttpBytesResponse`).
 */
export function httpGetBytes(
  url: URL,
  options: GetOptions = {},
): Promise<HttpBytesResponse> {
  const headers = options.headers ?? {};
  const insecure = options.insecure === true;
  return withTimeouts(
    options.timeouts ?? DEFAULT_TIMEOUTS,
    (signal, onHeaders) =>
      url.protocol === "https:" && insecure
        ? sendInsecure(url, headers, signal, onHeaders)
        : sendFetch(url, { method: "GET", headers, signal }, onHeaders),
  );
}

/**
 * Вызов произвольным методом с готовым телом — под теми же двумя
 * пределами и с той же формой причины отказа. Отдельно от `httpGet`, а
 * не флагом в нём: тело-байты и отключённая проверка TLS — свойства
 * GET-пути (снимок логов Portainer), и метод с телом к ним отношения не
 * имеет. Тип содержимого объявляет клиент своим заголовком: как
 * сериализовано тело, транспорт не знает.
 */
export async function httpSend(
  url: URL,
  options: SendOptions = {},
): Promise<HttpResponse> {
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  // Клиент живёт ровно один вызов и закрывается в любом исходе: он
  // держит пул соединений, а незакрытый — незакрытый ресурс, на
  // котором санитайзеры тестов краснеют по делу.
  const client = proxyClient(options.proxy);
  try {
    const response = await withTimeouts(
      options.timeouts ?? DEFAULT_TIMEOUTS,
      (signal, onHeaders) =>
        url.protocol === "https:" && options.insecure === true
          ? sendInsecure(url, headers, signal, onHeaders, {
            method,
            body: options.body,
          })
          : sendFetch(
            url,
            { method, headers, body: options.body, signal },
            onHeaders,
            client,
          ),
    );
    return {
      status: response.status,
      text: new TextDecoder().decode(response.bytes),
      retryAfter: response.retryAfter,
    };
  } finally {
    client?.close();
  }
}

/**
 * Оба предела на одну попытку: `run` получает сигнал отмены и колбэк
 * «заголовки пришли». Общий шов `httpGetBytes` и `httpSend` — пределы
 * времени одинаковы для всех вызовов, и второй способ их отмерять
 * разошёлся бы с первым.
 */
async function withTimeouts(
  timeouts: RequestTimeouts,
  run: (
    signal: AbortSignal,
    onHeaders: () => void,
  ) => Promise<HttpBytesResponse>,
): Promise<HttpBytesResponse> {
  const controller = new AbortController();
  // Какой из двух таймеров сработал — читается в catch, чтобы причина
  // называла свой предел, а не общий текст AbortError у fetch и
  // node:https («The operation was aborted» — не годится как причина).
  // Гвард «уже прерван» обязателен: при пределах вплотную (например,
  // 1ms/2ms) оба таймера успевают тикнуть до того, как catch дочитает
  // timeoutMessage, и без гварда таймер, сработавший вторым, тихо
  // переписывает причину первого — сообщение флапает между двумя
  // текстами (было проверено гонкой в portainer_test.ts).
  let timeoutMessage: string | undefined;
  const headersTimer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutMessage =
      `no response headers within ${timeouts.headersTimeoutMs}ms`;
    controller.abort();
  }, timeouts.headersTimeoutMs);
  const total = limited(timeouts.totalTimeoutMs);
  const totalTimer = total === null ? undefined : setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutMessage = `no response within ${total}ms`;
    controller.abort();
  }, total);
  try {
    return await run(controller.signal, () => clearTimeout(headersTimer));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpCallError(timeoutMessage ?? firstLine(message), {
      cause: err,
    });
  } finally {
    clearTimeout(headersTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
  }
}

/**
 * Предел вызова, пригодный для таймера. Значение шире int32 — ошибка
 * вызывающего, а не повод молча превратить его в одну миллисекунду:
 * отсутствие предела выражается `null`.
 */
function limited(totalTimeoutMs: number | null): number | null {
  if (totalTimeoutMs !== null && totalTimeoutMs > MAX_TIMER_MS) {
    throw new HttpCallError(
      `предел вызова ${totalTimeoutMs}ms не выражается таймером;` +
        " отсутствие предела задаётся null",
    );
  }
  return totalTimeoutMs;
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

/** Обычный путь запроса — `fetch`; тело передаётся как есть. */
/** Длина тела в байтах: строка считается в UTF-8, буфер — как есть. */
function byteLength(body: string | Uint8Array<ArrayBuffer>): number {
  return typeof body === "string"
    ? new TextEncoder().encode(body).length
    : body.length;
}

async function sendFetch(
  url: URL,
  init: RequestInit,
  onHeaders: () => void,
  client?: Deno.HttpClient,
): Promise<HttpBytesResponse> {
  // `client` — расширение Deno поверх стандартного `RequestInit`: в
  // типе веб-API его нет, а в реализации оно и есть единственный способ
  // увести запрос в прокси.
  const response = await fetch(
    url,
    client === undefined ? init : { ...init, client } as RequestInit,
  );
  onHeaders();
  return {
    status: response.status,
    bytes: new Uint8Array(await response.arrayBuffer()),
    retryAfter: response.headers.get("retry-after"),
  };
}

/**
 * Путь с отключённой проверкой TLS-сертификата на `https:`: у Deno нет
 * клиентской опции, гасящей её у `fetch` (`Deno.createHttpClient` её не
 * имеет, `NODE_TLS_REJECT_UNAUTHORIZED` на `fetch` не влияет —
 * проверено в этом дереве). Единственный работающий путь — `node:https`
 * с `rejectUnauthorized: false`. Метод и тело — параметр: у Portainer
 * ими ходят доставка stdin (`PUT`) и создание exec'а (`POST`), и
 * отключать проверку им нужно ровно так же, как чтениям.
 */
function sendInsecure(
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  onHeaders: () => void,
  payload: {
    readonly method: string;
    readonly body?: string | Uint8Array<ArrayBuffer>;
  } = { method: "GET" },
): Promise<HttpBytesResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: payload.method,
        // Длина тела известна всегда, и без неё `node:https` уходит в
        // chunked — на проводе это уже не тот запрос, что у `fetch`.
        headers: payload.body === undefined
          ? headers
          : { ...headers, "Content-Length": String(byteLength(payload.body)) },
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
            bytes: new Uint8Array(Buffer.concat(chunks)),
            // Значение заголовка приходит строкой; списком — только у
            // тех заголовков, которые повторяются (`set-cookie`).
            retryAfter: typeof res.headers["retry-after"] === "string"
              ? res.headers["retry-after"]
              : null,
          }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload.body !== undefined) req.write(payload.body);
    req.end();
  });
}

/**
 * Клиент, уводящий запрос в прокси; прокси не задан — `undefined` и
 * прямое соединение. Непригодное значение доходит сюда только мимо
 * проверки вызывающего, поэтому отказ оформляется своей ошибкой вызова,
 * а не пробрасывается сырым текстом клиента («invalid proxy url»).
 */
function proxyClient(proxy: string | undefined): Deno.HttpClient | undefined {
  if (proxy === undefined || proxy === "") return undefined;
  try {
    return Deno.createHttpClient({ proxy: { url: proxy } });
  } catch (err) {
    throw new HttpCallError(
      `прокси не принят клиентом — '${proxy}': ${
        firstLine(err instanceof Error ? err.message : String(err))
      }`,
      { cause: err },
    );
  }
}
