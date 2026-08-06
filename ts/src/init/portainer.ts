/**
 * HTTP-клиент Portainer API (`docs/specs/init.md`, шаг 2): список
 * environment'ов и список контейнеров внутри одного из них. Модуль не
 * знает о командах, кэш-БД или конфигурации — только о протоколе
 * Portainer/Docker и о том, как назвать его отказ. Пределы времени и
 * транспорт — общие для клиентов Portainer, Loki и Kaiten (`../http/mod.ts`).
 */

import {
  DEFAULT_TIMEOUTS,
  firstLine,
  httpGet,
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
 */
export async function fetchPortainerJson<T>(
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
