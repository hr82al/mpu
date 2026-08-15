/**
 * HTTP-клиент Portainer API (`docs/specs/init.md`, шаг 2;
 * `docs/specs/logs.md`, portainer-путь): список environment'ов, список
 * контейнеров внутри одного из них и снимок логов контейнера. Модуль не
 * знает о командах, кэш-БД или конфигурации — только о протоколе
 * Portainer/Docker и о том, как назвать его отказ. Пределы времени и
 * транспорт — общие для клиентов Portainer, Loki и Kaiten (`../http/mod.ts`).
 *
 * Модуль вынесен из `src/init/`: со вторым потребителем (`logs`) это
 * платформенная граница, а не часть команды init, и импорт мимо
 * `mod.ts` нарушил бы границу модулей — тем же путём раньше уехал
 * клиент Loki.
 */

import {
  DEFAULT_TIMEOUTS,
  firstLine,
  httpGet,
  httpGetBytes,
  type RequestTimeouts,
} from "../http/mod.ts";

/** Environment Portainer: пара (base_url, id) адресует Docker API сервера. */
export interface PortainerEndpoint {
  readonly id: number;
  readonly name: string;
  /**
   * Контракт Portainer CE: 1 — доступен, 2 — недоступен. Любое значение,
   * кроме 1, трактуется вызывающей стороной как недоступен (`init.md`,
   * шаг 2) — это решение принимает команда, не этот клиент протокола.
   */
  readonly status: number;
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
 * пределов, HTTP-код вне 2xx. Причина — всегда одной строкой (вердикт
 * fix спеки; одной строкой её делает `../http/mod.ts`).
 */
export class PortainerError extends Error {
  override name = "PortainerError";
}

/** Форма `/api/endpoints` — берутся только используемые поля. */
interface RawEndpoint {
  readonly Id: number;
  readonly Name: string;
  readonly Status: number;
}

/** Форма элемента `/containers/json` — берутся только используемые поля. */
interface RawContainer {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly State: string;
  readonly Image: string;
}

/**
 * Все окружения Portainer (`Portainer-endpoint` глоссария) с их статусом
 * доступности, как его отдаёт `GET /api/endpoints`.
 */
export async function listEndpoints(
  access: PortainerAccess,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<readonly PortainerEndpoint[]> {
  const raw = await fetchPortainerJson<readonly RawEndpoint[]>(
    access,
    "/api/endpoints",
    timeouts,
  );
  return raw.map((e) => ({ id: e.Id, name: e.Name, status: e.Status }));
}

/**
 * Все контейнеры одного окружения, включая остановленные: запрос идёт
 * в Docker API окружения через Portainer (`…/docker/containers/json`).
 * Имена — как их отдаёт Docker, с ведущим `/`; снятие слэша — дело
 * потребителя.
 */
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

/** Что спрашивают у Docker при снимке логов контейнера. */
export interface ContainerLogsQuery {
  readonly stdout: boolean;
  readonly stderr: boolean;
  /** Сколько последних строк отдать. */
  readonly tail: number;
  readonly timestamps: boolean;
  /** Нижняя граница, unix-секунды; не задана — весь доступный лог. */
  readonly sinceUnix?: number;
}

/**
 * Снимок логов контейнера (`logs.md`, portainer-путь): тело —
 * мультиплексированный поток Docker, поэтому возвращаются байты, а не
 * текст (разбор — `demuxDockerStream`). `follow=false` зашит: команде
 * нужен снимок, слежение живёт только на Loki-пути.
 */
export async function fetchContainerLogs(
  access: PortainerAccess,
  endpointId: number,
  container: string,
  query: ContainerLogsQuery,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<Uint8Array> {
  const url = new URL(
    `${access.baseUrl}/api/endpoints/${endpointId}/docker/containers/` +
      `${encodeURIComponent(container)}/logs`,
  );
  // Порядок параметров — порядок спеки: адрес запроса читают глазами в
  // логах прокси, и стабильный порядок там дороже, чем экономия строк.
  url.searchParams.set("stdout", String(query.stdout));
  url.searchParams.set("stderr", String(query.stderr));
  url.searchParams.set("tail", String(query.tail));
  url.searchParams.set("follow", "false");
  url.searchParams.set("timestamps", String(query.timestamps));
  if (query.sinceUnix !== undefined) {
    url.searchParams.set("since", String(query.sinceUnix));
  }
  try {
    const response = await httpGetBytes(url, {
      headers: { "X-API-Key": access.apiKey },
      timeouts,
      insecure: !access.verifyTls,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new PortainerError(`HTTP ${response.status}`);
    }
    return response.bytes;
  } catch (err) {
    if (err instanceof PortainerError) throw err;
    throw new PortainerError(
      firstLine(err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
}

/** Разделённые потоки снимка логов: что Docker отдал как stdout и stderr. */
export interface DockerStreams {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** Длина заголовка кадра мультиплексированного потока Docker. */
const FRAME_HEADER = 8;

/**
 * Демультиплексирование потока Docker (`logs.md`, portainer-путь):
 * кадры с восьмибайтовым заголовком, байт 0 — поток (0=stdin, 1=stdout,
 * 2=stderr), байты 4–7 — длина payload big-endian. Кадры потока 0 и
 * неполный хвостовой кадр отбрасываются.
 *
 * Если первый байт ответа не попадает в {0,1,2}, фрейминга нет вовсе
 * (контейнер с tty) — весь ответ целиком считается stdout-частью.
 */
export function demuxDockerStream(bytes: Uint8Array): DockerStreams {
  if (bytes.length === 0) return { stdout: bytes, stderr: bytes };
  if (bytes[0] > 2) return { stdout: bytes, stderr: new Uint8Array() };

  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + FRAME_HEADER <= bytes.length) {
    const size = header.getUint32(offset + 4, false);
    const end = offset + FRAME_HEADER + size;
    // Хвост короче объявленной длины — кадр неполный и целиком
    // отбрасывается: половина строки хуже её отсутствия.
    if (end > bytes.length) break;
    const payload = bytes.subarray(offset + FRAME_HEADER, end);
    if (bytes[offset] === 1) stdout.push(payload);
    if (bytes[offset] === 2) stderr.push(payload);
    offset = end;
  }
  return { stdout: concat(stdout), stderr: concat(stderr) };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * GET на путь Portainer API, разобранный как JSON. Пределы вызова —
 * параметр со значением по умолчанию, а не константа внутри: тест
 * молчащего сервера обязан укладываться в доли секунды, а не ждать
 * реальные три секунды продуктового предела (`ts/CLAUDE.md`: сон стеной
 * в тестах запрещён). Тем же швом пользуется тест молчащего endpoint'а
 * на уровне команды — через `runInit`.
 */
async function fetchPortainerJson<T>(
  access: PortainerAccess,
  path: string,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<T> {
  try {
    const response = await httpGet(new URL(`${access.baseUrl}${path}`), {
      headers: { "X-API-Key": access.apiKey },
      timeouts,
      insecure: !access.verifyTls,
    });
    if (response.status < 200 || response.status >= 300) {
      // Текст `HTTP <код>` — дословная форма причины из спеки
      // (`init.md`, шаг 2), не общий стиль ошибок проекта (там — с
      // маленькой буквы): `HTTP` здесь имя протокола, а не первое слово
      // предложения, как и заглавная буква в аналогичном исключении
      // `env/mod.ts` (`require`, комментарий рядом).
      throw new PortainerError(`HTTP ${response.status}`);
    }
    // Форма ответа фиксирована протоколом Portainer/Docker (`init.md`,
    // шаг 2): поля берутся по контракту внешней системы, а не заново
    // валидируются здесь — рантайм-схема на два эндпоинта добавила бы
    // ветки, которые нечем проверить (YAGNI), не приблизив к задаче.
    return JSON.parse(response.text) as T;
  } catch (err) {
    if (err instanceof PortainerError) throw err;
    // Сюда попадают отказ транспорта (`HttpCallError`, причина уже одной
    // строкой) и разбор тела, не являющегося JSON.
    throw new PortainerError(
      firstLine(err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
}
