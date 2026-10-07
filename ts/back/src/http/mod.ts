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
 * нарушил бы границу модулей. Здесь же — сборка тела
 * `multipart/form-data` (`./multipart.ts`): формат общий, а клиентов,
 * посылающих файлы, уже два.
 */

import { Buffer } from "node:buffer";
import type { ClientRequest, IncomingMessage } from "node:http";
import process from "node:process";
import {
  type ProxyEnv,
  type Route,
  type RouteChoice,
  routeOf,
  UnusableProxyError,
} from "./route.ts";

// Сборщик тела `multipart/form-data` — часть поверхности транспорта:
// потребителей у него двое (вызовы Kaiten с файлами и `sendDocument`
// Bot API), а внутренности модуля мимо `mod.ts` не импортируются.
export { withoutCredentials } from "./credentials.ts";
export type { ProxyEnv } from "./route.ts";
export {
  buildMultipartBody,
  type MultipartBody,
  type MultipartPart,
} from "./multipart.ts";

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
 * Причина — всегда одной строкой (вердикт fix `init.md`): у сетевых
 * ошибок бывает многострочное сообщение со второй строкой-подсказкой,
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
  /**
   * Окружение, из которого берётся прокси (`HTTP_PROXY`, `HTTPS_PROXY`,
   * `ALL_PROXY`, `NO_PROXY`); умолчание — окружение процесса. Параметром,
   * а не чтением по месту: тест подставляет своё, не трогая процесс.
   */
  readonly env?: ProxyEnv;
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
   * явно: тело собирают клиенты, а сборщик `multipart` отдаёт именно
   * неразделяемый буфер.
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
   * Прокси-URL для этого вызова. Не задан или пуст — адрес стенда
   * (`./stand.ts`) соединяется напрямую, остальные адреса идут через
   * прокси окружения, если он задан (`docs/specs/platform/loki-http.md`,
   * «Прокси окружения»; `./route.ts`). При `insecure` на `https:` не
   * применяется. Параметром, а не переменной окружения: адресность
   * важна — этот прокси нужен вызовам наружу (`api.telegram.org`,
   * `docs/specs/telegram-log.md`).
   *
   * Схемы — `http`, `https`, `socks5`, `socks5h` (`./route.ts`).
   * Пригодность значения проверяет вызывающий:
   * у него есть имя ключа, которым его настроили, и отказ он назовёт
   * точнее.
   */
  readonly proxy?: string;
  /**
   * Отмена вызова снаружи, сверх двух пределов: долгий опрос Bot API
   * держит соединение до 35 с, и остановка ядра его не ждёт
   * (`docs/specs/platform/telegram-questions.md`). Отменённый вызов —
   * тот же `HttpCallError`.
   */
  readonly signal?: AbortSignal;
  /** Окружение для прокси — то же, что у `GetOptions`. */
  readonly env?: ProxyEnv;
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
 * Прокси окружения обходится только для адресов сети стенда
 * (`./stand.ts`, `platform/loki-http.md`); маршрут выбирает `./route.ts`.
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
export async function httpGetBytes(
  url: URL,
  options: GetOptions = {},
): Promise<HttpBytesResponse> {
  const choice = {
    insecure: options.insecure === true,
    env: options.env ?? process.env,
  };
  return await withTimeouts(
    options.timeouts ?? DEFAULT_TIMEOUTS,
    undefined,
    (signal, onHeaders) =>
      follow({ url, method: "GET", headers: options.headers ?? {} }, choice, {
        signal,
        onHeaders,
      }),
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
  const choice = {
    proxy: options.proxy,
    insecure: options.insecure === true,
    env: options.env ?? process.env,
  };
  const response = await withTimeouts(
    options.timeouts ?? DEFAULT_TIMEOUTS,
    options.signal,
    (signal, onHeaders) =>
      follow(
        {
          url,
          method: options.method ?? "GET",
          headers: options.headers ?? {},
          body: options.body,
        },
        choice,
        { signal, onHeaders },
      ),
  );
  return {
    status: response.status,
    text: new TextDecoder().decode(response.bytes),
    retryAfter: response.retryAfter,
  };
}

/**
 * Оба предела на одну попытку: `run` получает сигнал отмены и колбэк
 * «заголовки пришли». Общий шов `httpGetBytes` и `httpSend` — пределы
 * времени одинаковы для всех вызовов, и второй способ их отмерять
 * разошёлся бы с первым.
 */
async function withTimeouts(
  timeouts: RequestTimeouts,
  outside: AbortSignal | undefined,
  run: (
    signal: AbortSignal,
    onHeaders: () => void,
  ) => Promise<HttpBytesResponse>,
): Promise<HttpBytesResponse> {
  const controller = new AbortController();
  // Какой из двух таймеров сработал — читается в catch, чтобы причина
  // называла свой предел, а не общий текст AbortError у node:http(s)
  // («The operation was aborted» — не годится как причина).
  // Гвард «уже прерван» обязателен: при пределах вплотную (например,
  // 1ms/2ms) оба таймера успевают тикнуть до того, как catch дочитает
  // timeoutMessage, и без гварда таймер, сработавший вторым, тихо
  // переписывает причину первого — сообщение флапает между двумя
  // текстами (было проверено гонкой в portainer.test.ts).
  let timeoutMessage: string | undefined;
  const headersTimer = setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutMessage = `no response headers within ${timeouts.headersTimeoutMs}ms`;
    controller.abort();
  }, timeouts.headersTimeoutMs);
  const total = limited(timeouts.totalTimeoutMs);
  const totalTimer =
    total === null
      ? undefined
      : setTimeout(() => {
          if (controller.signal.aborted) return;
          timeoutMessage = `no response within ${total}ms`;
          controller.abort();
        }, total);
  // Отмена снаружи — тот же контроллер: причина отказа тогда — текст
  // рантайма об отмене, а таймеры снимаются в `finally` как обычно.
  const signal =
    outside === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, outside]);
  try {
    return await run(signal, () => clearTimeout(headersTimer));
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
 * многострочного случая: у сетевых ошибок он воспроизводим не в каждой среде
 * (в этом дереве не увиделся живьём ни разу — см. `portainer.test.ts`),
 * а инвариант «причина одной строкой» обязан быть проверен собственным
 * тестом, а не только косвенно через happy path.
 */
export function firstLine(message: string): string {
  const end = message.indexOf("\n");
  return end === -1 ? message : message.slice(0, end);
}

/** Длина тела в байтах: строка считается в UTF-8, буфер — как есть. */
function byteLength(body: string | Uint8Array<ArrayBuffer>): number {
  return typeof body === "string"
    ? new TextEncoder().encode(body).length
    : body.length;
}

/**
 * Предел переходов по редиректам — тот же, что у `fetch`, которым
 * транспорт ходил прежде: потребители на следовании полагаются (webapp
 * таблиц отвечает 302 на `script.googleusercontent.com`).
 */
const MAX_REDIRECTS = 20;

/** Коды ответа, за которыми транспорт идёт по `Location`. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Заголовки тела: при смене метода на `GET` уходят вместе с ним. */
const BODY_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-encoding",
  "content-language",
  "content-location",
]);

/** Один запрос цепочки: адрес, метод, заголовки и тело. */
interface Hop {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array<ArrayBuffer>;
}

/** Ответ одного запроса вместе с адресом перехода. */
interface HopResponse extends HttpBytesResponse {
  readonly location: string | null;
}

/** Сигнал отмены и отметка «заголовки пришли» — от `withTimeouts`. */
interface CallControl {
  readonly signal: AbortSignal;
  readonly onHeaders: () => void;
}

/**
 * Запрос с переходами по редиректам, как у `fetch`: маршрут — свой у
 * каждого перехода (у нового адреса свои стенд и `NO_PROXY`), пределы
 * времени — одни на всю цепочку.
 */
async function follow(
  first: Hop,
  choice: RouteChoice,
  call: CallControl,
): Promise<HttpBytesResponse> {
  let hop = first;
  for (let redirects = 0; ; redirects++) {
    const { location, ...response } = await sendHop(hop, choice, call);
    if (!isRedirect(response.status, location)) return response;
    if (redirects === MAX_REDIRECTS) {
      throw new Error(`больше ${MAX_REDIRECTS} переходов по редиректам`);
    }
    hop = redirected(hop, response.status, location);
  }
}

/** Ответ — редирект, по которому есть куда идти. */
function isRedirect(
  status: number,
  location: string | null,
): location is string {
  return REDIRECTS.has(status) && location !== null;
}

/**
 * Следующий запрос по ответу-редиректу. Метод меняется на `GET`, тело и
 * его заголовки уходят — на 303 при любом методе, кроме `GET`/`HEAD`, и на
 * 301/302 при `POST`; 307/308 метод и тело сохраняют. При смене origin
 * снимается `Authorization`.
 */
function redirected(hop: Hop, status: number, location: string): Hop {
  const url = redirectTarget(hop.url, location);
  const toGet =
    (status === 303 && hop.method !== "GET" && hop.method !== "HEAD") ||
    ((status === 301 || status === 302) && hop.method === "POST");
  const dropped = new Set<string>(toGet ? BODY_HEADERS : []);
  if (url.origin !== hop.url.origin) dropped.add("authorization");
  const headers = Object.fromEntries(
    Object.entries(hop.headers).filter(
      ([name]) => !dropped.has(name.toLowerCase()),
    ),
  );
  return toGet
    ? { url, method: "GET", headers }
    : { url, method: hop.method, headers, body: hop.body };
}

/**
 * Адрес перехода: относительный `Location` — от адреса запроса. Как у
 * `fetch`, годятся только `http:`/`https:` без учётных данных.
 */
function redirectTarget(from: URL, location: string): URL {
  let url: URL;
  try {
    url = new URL(location, from);
  } catch (err) {
    throw new Error("редирект на неразбираемый адрес", { cause: err });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`редирект на схему ${url.protocol.replace(":", "")}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("редирект на адрес с учётными данными");
  }
  return url;
}

/** Один запрос по своему маршруту; маршрут закрывается в любом исходе. */
async function sendHop(
  hop: Hop,
  choice: RouteChoice,
  call: CallControl,
): Promise<HopResponse> {
  const route = routeFor(hop.url, choice);
  try {
    // Длина тела известна всегда, и без неё `node:http` уходит в chunked.
    const headers =
      hop.body === undefined
        ? hop.headers
        : {
            ...hop.headers,
            "Content-Length": String(byteLength(hop.body)),
          };
    const { request, options } = await route.open(hop.url, headers);
    return await exchange(
      request({
        ...options,
        method: hop.method,
        // У `http:` проверять нечего; у `https:` проверка отключается
        // только по явному `insecure`.
        rejectUnauthorized: !choice.insecure,
        signal: call.signal,
      }),
      hop.body,
      call,
    );
  } finally {
    route.close();
  }
}

/**
 * Маршрут вызова (`./route.ts`). Непригодный прокси доходит сюда только
 * мимо проверки вызывающего, поэтому отказ оформляется своей ошибкой
 * вызова, а не пробрасывается сырым текстом разбора.
 */
function routeFor(url: URL, choice: RouteChoice): Route {
  try {
    return routeOf(url, choice);
  } catch (err) {
    if (!(err instanceof UnusableProxyError)) throw err;
    throw new HttpCallError(
      `прокси не принят клиентом — '${err.proxy}': ${firstLine(err.message)}`,
      { cause: err },
    );
  }
}

/**
 * Отправляет тело и собирает ответ. Отказ прокси открыть туннель
 * (CONNECT не 200) — отказ вызова: иначе 407 или 403 прокси дошли бы до
 * клиента ответом самого API.
 */
function exchange(
  req: ClientRequest,
  body: string | Uint8Array<ArrayBuffer> | undefined,
  call: CallControl,
): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    req.on("proxyConnect", ({ statusCode }: { statusCode: number }) => {
      if (statusCode === 200) return;
      req.destroy(new Error(`прокси отказал в туннеле: ${statusCode}`));
    });
    req.on("response", (res) => collect(res, call).then(resolve, reject));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Ответ целиком. Предел заголовков снимается только ответом, который не
 * редирект: следующий переход ждёт свои заголовки под тем же пределом,
 * иначе при вызове без общего предела молчащий переход висел бы вечно.
 */
function collect(
  res: IncomingMessage,
  call: CallControl,
): Promise<HopResponse> {
  // `statusCode` типизирован `number | undefined`, потому что
  // `IncomingMessage` общий для клиента и сервера (у серверного запроса его
  // нет); здесь ответ всегда клиентский, и к событию `response` статус уже
  // разобран.
  const status = res.statusCode!;
  const location = single(res.headers.location);
  if (!isRedirect(status, location)) call.onHeaders();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () =>
      resolve({
        status,
        bytes: new Uint8Array(Buffer.concat(chunks)),
        retryAfter: single(res.headers["retry-after"]),
        location,
      }),
    );
    res.on("error", reject);
  });
}

/**
 * Значение заголовка ответа: приходит строкой; списком — только у тех
 * заголовков, которые повторяются (`set-cookie`); нет — `null`.
 */
function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}
