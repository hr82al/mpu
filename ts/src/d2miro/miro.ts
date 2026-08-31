/**
 * Клиент Miro API — граница, снятая с живой службы
 * (`docs/specs/d2-miro.md`, «Снято с живой службы 2026-08-31»;
 * фикстуры — `fixtures/d2-miro/live/`).
 *
 * Отпечатки службы, ради которых клиент выглядит именно так:
 *
 * - `POST /frames|/shapes|/texts` отвечает `201`, а `POST /connectors`
 *   — `200`. Поэтому успех определяется диапазоном `2xx`, а не
 *   списком кодов: список пришлось бы держать в двух местах.
 * - `POST /frames` отвечает `500` примерно в половине попыток при
 *   живой квоте (`x-ratelimit-remaining` 97 600 из 100 000), и
 *   повтор лечит. Отсюда главное расхождение с оригиналом: клиент
 *   повторяет **и `5xx`**, а не только `429` (оригинал —
 *   `py/src/mpu/lib/http_retry.py:36`), и **считает повторы**, чтобы
 *   итог назвал их числом.
 * - `DELETE /frames/{id}` детей не удаляет: они остаются сиротами с
 *   `parent: null`. Обход детей — обязанность вызывающего
 *   (`render.ts`), клиент этого за него не делает.
 * - Повторное удаление отвечает `404` с кодом `"3.0201"`; для
 *   удаления это успех, а не отказ.
 *
 * Токен живёт только в заголовке: в тексты ошибок идут метод, путь и
 * тело ответа — инвариант спеки «токен не попадает ни в вывод, ни в
 * тексты ошибок».
 */

/** Отказ службы, который повтором не лечится. */
export class MiroError extends Error {
  override readonly name = "MiroError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Минимум от `fetch`, который нужен клиенту. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

/** Зависимости клиента: сеть, сон и диагностическая строка. */
export interface MiroIo {
  readonly fetch: FetchLike;
  /** Пауза между попытками; в тестах — без настоящего сна. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Строка `[miro] …` в stderr. */
  readonly note: (line: string) => void;
}

/** Элемент доски в том виде, в каком он нужен рендеру. */
export interface MiroItem {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

/** Потолок попыток одного запроса (спека: максимум 6). */
const MAX_ATTEMPTS = 6;
/** Потолок паузы между попытками, секунды. */
const MAX_SLEEP_S = 30;
/** Длина тела ответа в тексте ошибки (спека). */
const BODY_LIMIT = 300;
/** Размер страницы листинга; курсор — в ответе. */
const PAGE = 50;

/** Пауза перед попыткой номер `attempt` (1-я повторная — 1 с). */
function backoffSeconds(attempt: number): number {
  return Math.min(2 ** (attempt - 1), MAX_SLEEP_S);
}

/** Тело ответа для текста ошибки — обрезанное, без заголовков. */
function shortBody(text: string): string {
  return text.length <= BODY_LIMIT ? text : text.slice(0, BODY_LIMIT);
}

/** Клиент одной доски. */
export class MiroBoard {
  /** Сколько раз запрос пришлось повторить за жизнь клиента. */
  #retries = 0;
  readonly #base: string;

  constructor(
    private readonly io: MiroIo,
    boardId: string,
    private readonly token: string,
  ) {
    this.#base = `https://api.miro.com/v2/boards/${
      encodeURIComponent(boardId)
    }`;
  }

  /** Число повторов — итог обязан называть его числом (спека). */
  get retries(): number {
    return this.#retries;
  }

  /**
   * Запрос с повтором на `429` и `5xx`. Возвращает тело и статус —
   * решение «успех или отказ» принимает вызывающий метод: у удаления
   * `404` успех, у прочих нет.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    let lastNonRetryable: { status: number; text: string } | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await this.send(method, path, body);
      const text = await response.text();
      if (!retryable(response.status)) {
        lastNonRetryable = { status: response.status, text };
        break;
      }
      if (attempt === MAX_ATTEMPTS) {
        lastNonRetryable = { status: response.status, text };
        break;
      }
      await this.pause(response, attempt);
    }
    if (lastNonRetryable === undefined) {
      // Недостижимо: цикл выходит только через присваивание. Ветка
      // оставлена вместо `!`, чтобы отсутствие ответа не превращалось
      // в молчаливый `undefined` у вызывающего.
      throw new MiroError(0, `miro ${method} ${path} -> нет ответа`);
    }
    return lastNonRetryable;
  }

  /**
   * Один запрос к службе. Сбой самого обращения — не ответ, а отказ
   * своим классом: без этого он уходил бы наружу «unexpected error» с
   * трейсом, чего спека запрещает (отклонение-fix). Повтора у него
   * нет: сеть повторит вызывающий, а неверный заголовок повторять
   * бессмысленно — замер 2026-08-31, токен с кириллицей роняет
   * `fetch` до всякой сети.
   */
  private async send(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    try {
      return await this.io.fetch(`${this.#base}${path}`, {
        method,
        headers: {
          "authorization": `Bearer ${this.token}`,
          "accept": "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MiroError(
        0,
        `miro ${method} ${path}: transport error: ${message}`,
      );
    }
  }

  /** Пауза перед повтором с диагностической строкой. */
  private async pause(response: Response, attempt: number): Promise<void> {
    this.#retries++;
    const header = Number(response.headers.get("retry-after"));
    const seconds = response.status === 429 && Number.isFinite(header) &&
        header > 0
      ? Math.min(header, MAX_SLEEP_S)
      : backoffSeconds(attempt);
    this.io.note(
      response.status === 429
        ? `[miro] 429 rate-limit, sleep ${seconds}s`
        : `[miro] ${response.status} from service, retry ${attempt} in ` +
          `${seconds}s`,
    );
    await this.io.sleep(seconds * 1000);
  }

  /** Запрос, у которого не-2xx — отказ; отдаёт разобранный JSON. */
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, text } = await this.request(method, path, body);
    if (status < 200 || status >= 300) {
      throw new MiroError(
        status,
        `miro ${method} ${path} -> ${status}: ${shortBody(text)}`,
      );
    }
    return (text === "" ? {} : JSON.parse(text)) as T;
  }

  /** Все фреймы доски — полной пагинацией, а не первой страницей. */
  async frames(): Promise<readonly MiroItem[]> {
    return await this.page("/items?type=frame");
  }

  /** Дети фрейма — тоже полной пагинацией. */
  async children(frameId: string): Promise<readonly MiroItem[]> {
    return await this.page(
      `/items?parent_item_id=${encodeURIComponent(frameId)}`,
    );
  }

  /**
   * Обход страниц по курсору. Страница обрезает молча — сравнение
   * первых `limit` элементов дало бы ложное «состав совпал» (замер
   * спецификатора 2026-08-31).
   */
  private async page(path: string): Promise<readonly MiroItem[]> {
    const items: MiroItem[] = [];
    let cursor: string | undefined;
    do {
      const query = `${path}&limit=${PAGE}` +
        (cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const reply = await this.json<
        { data?: unknown[]; cursor?: string }
      >("GET", query);
      for (const raw of reply.data ?? []) items.push(itemOf(raw));
      cursor = reply.cursor === "" ? undefined : reply.cursor;
    } while (cursor !== undefined);
    return items;
  }

  /** Создание элемента: `201` у фрейма и шейпа, `200` у коннектора. */
  async create(path: string, body: unknown): Promise<string> {
    const created = await this.json<{ id?: string }>("POST", path, body);
    if (typeof created.id !== "string" || created.id === "") {
      throw new MiroError(0, `miro POST ${path}: в ответе нет id`);
    }
    return created.id;
  }

  /** Снятие блокировки; `400` и `404` терпимы (спека). */
  async unlock(id: string): Promise<void> {
    const { status } = await this.request(
      "PATCH",
      `/items/${encodeURIComponent(id)}`,
      { data: { locked: false } },
    );
    if (status === 400 || status === 404 || (status >= 200 && status < 300)) {
      return;
    }
    throw new MiroError(status, `miro PATCH /items/${id} -> ${status}`);
  }

  /**
   * Удаление элемента или фрейма: `404` — успех (уже удалён), `400` со
   * словом `locked` — разлочить и повторить один раз.
   */
  async remove(path: string, id: string): Promise<void> {
    const target = `${path}/${encodeURIComponent(id)}`;
    const first = await this.request("DELETE", target);
    if (deleted(first.status)) return;
    if (first.status === 400 && first.text.includes("locked")) {
      await this.unlock(id);
      const second = await this.request("DELETE", target);
      if (deleted(second.status)) return;
      throw new MiroError(
        second.status,
        `miro DELETE ${target} -> ${second.status}: ${shortBody(second.text)}`,
      );
    }
    throw new MiroError(
      first.status,
      `miro DELETE ${target} -> ${first.status}: ${shortBody(first.text)}`,
    );
  }
}

/** Повторяемый исход: троттлинг и любой отказ самой службы. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Удаление удалось: 2xx либо «уже удалён». */
function deleted(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404;
}

/** Элемент ответа службы в том виде, в каком он нужен рендеру. */
function itemOf(raw: unknown): MiroItem {
  const item = raw as {
    id?: unknown;
    type?: unknown;
    data?: { title?: unknown };
    position?: { x?: unknown; y?: unknown };
    geometry?: { width?: unknown; height?: unknown };
  };
  return {
    id: String(item.id ?? ""),
    type: String(item.type ?? ""),
    title: typeof item.data?.title === "string" ? item.data.title : undefined,
    x: numberOf(item.position?.x),
    y: numberOf(item.position?.y),
    width: numberOf(item.geometry?.width),
    height: numberOf(item.geometry?.height),
  };
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
