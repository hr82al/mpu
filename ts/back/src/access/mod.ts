/**
 * Доступ к серверам на петле (`platform/mcp-server.md`, «Конфигурация»;
 * `platform/back-rpc.md`, «Доступ»): чей `Origin` пускать и верен ли
 * токен. Одно место на MCP-сервер и `mpu-back`.
 */

/** Интерфейс, на котором слушают серверы: только петля. */
export const LOOPBACK = "127.0.0.1";

/** Хосты `Origin`, которым сервер отвечает. */
export class Origins {
  readonly #hosts: ReadonlySet<string>;

  constructor(hosts: readonly string[]) {
    this.#hosts = new Set(hosts);
  }

  /** Тот же список и ещё хост `host`. */
  with(host: string): Origins {
    return new Origins([...this.#hosts, host]);
  }

  /**
   * Пускать ли страницу с этим `Origin`. Запрос без `Origin` решает
   * вызывающий: так ходят не-браузерные клиенты.
   */
  allows(origin: string): boolean {
    try {
      // Для IPv6 `hostname` отдаёт адрес в скобках — сравниваем с ним.
      return this.#hosts.has(new URL(origin).hostname);
    } catch {
      // Неразбираемый Origin — заведомо не свой: отказ, а не падение.
      return false;
    }
  }
}

/** Страница с той же машины. */
export const LOOPBACK_ORIGINS = new Origins([LOOPBACK, "localhost", "[::1]"]);

/**
 * Токен в заголовке `Authorization`. Сравнение обычное, не постоянного
 * времени: сервер слушает петлю, недоверенной стороны в этой системе нет
 * (`ts/CLAUDE.md`, «Права Deno»), а тайминг по петле не отличим от шума.
 */
export function hasBearer(request: Request, token: string): boolean {
  return request.headers.get("Authorization") === `Bearer ${token}`;
}
