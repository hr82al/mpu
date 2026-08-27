/**
 * Транспорт GitLab MR API (`platform/gitlab-api.md`, «HTTP-клиент»):
 * адрес, заголовки, пределы времени, пагинация и форма отказа.
 *
 * Ниже — общий `httpSend` (`../http/mod.ts`): отмена по двум пределам
 * и причина сетевого сбоя одной строкой решены там. Здесь только
 * трактовка протокола GitLab: что считается отказом и как выглядит
 * его текст.
 *
 * Прокси не передаётся ни одному вызову: хост внутренний, и
 * системные `HTTP_PROXY`/`HTTPS_PROXY` для него означали бы попытку
 * достучаться до внутреннего GitLab через внешний прокси.
 */

import { HttpCallError, httpSend, type RequestTimeouts } from "../http/mod.ts";
import type { RawObject } from "./model.ts";

/** Дефолт `GITLAB_BASE_URL`, когда ключ не задан (спека). */
export const DEFAULT_BASE_URL = "https://gitlab.btlz-api.ru";

/**
 * Пределы шире умолчания транспорта (3 s/10 s): у `/changes` крупного
 * MR тело в мегабайты, и десяти секунд на весь вызов не хватает.
 *
 * Оба предела равны 30 s намеренно. Спека называет «30 s (connect
 * 10 s)», но десять секунд там отмеряют **установление соединения**, а
 * наш транспорт умеет только «сколько ждать заголовков» — то есть
 * время, которое сервер думает над ответом. Приложив десятку к
 * заголовкам, мы отбивали бы вызов там, где рабочая версия дотерпит:
 * `/discussions` активного MR отвечает за шесть секунд и на медленном
 * дне легко переваливает за десять (замер пары 2026-08-28 — первый
 * прогон упал по этому пределу, два следующих прошли). Пока connect
 * отдельным пределом не отмеряется, действует один: весь вызов.
 */
export const TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: 30_000,
  totalTimeoutMs: 30_000,
};

/** Размер страницы пагинированных GET (спека). */
const PAGE_SIZE = 100;

/** Тело отказа в сообщении обрезается до 300 символов (спека). */
const ERROR_BODY_LIMIT = 300;

/** Подключение к GitLab: база и personal access token. */
export interface GitlabAccess {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Отказ обращения к GitLab: не-2xx либо сетевой сбой. Статус хранится
 * отдельно от текста — по нему команда выбирает подсказку (401 — про
 * токен, 404 — про форму `--mr`), а разбирать его из сообщения назад
 * значило бы читать собственный текст регулярным выражением.
 */
export class GitlabError extends Error {
  override name = "GitlabError";
  /** HTTP-код ответа; у сетевого сбоя — 0 (спека). */
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/** Один GET; путь — логический, от `/api/v4` (например `/projects/…`). */
export async function gitlabGet(
  access: GitlabAccess,
  path: string,
  query: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const url = new URL(`${trimSlash(access.baseUrl)}/api/v4${path}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  let response;
  try {
    response = await httpSend(url, {
      method: "GET",
      headers: {
        // Значение токена не попадает ни в одно сообщение этого модуля:
        // тексты собираются из метода, пути и тела ответа.
        "PRIVATE-TOKEN": access.token,
        "Accept": "application/json",
      },
      timeouts: TIMEOUTS,
    });
  } catch (err) {
    if (err instanceof HttpCallError) {
      // Сетевой сбой: статуса нет, поэтому 0 и текст сбоя вместо тела.
      throw failure("GET", path, query, 0, err.message, { cause: err });
    }
    throw err;
  }
  if (response.status < 200 || response.status >= 300) {
    throw failure("GET", path, query, response.status, response.text);
  }
  return parseJson(response.text, path);
}

/**
 * Пагинированный GET: страницы по 100 до первой короче ста. Ровно сто
 * элементов означают «может быть ещё» — на активном MR тредов больше
 * двадцати, и остановка на первой странице теряла бы их молча.
 */
export async function gitlabGetAll(
  access: GitlabAccess,
  path: string,
  query: Readonly<Record<string, string>> = {},
): Promise<readonly RawObject[]> {
  const items: RawObject[] = [];
  for (let page = 1;; page += 1) {
    const body = await gitlabGet(access, path, {
      ...query,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    // Длина страницы считается по ответу, а не по пережившим отбор:
    // один не-объект в сотне элементов иначе выглядел бы как «страница
    // короче ста», и все следующие страницы потерялись бы молча.
    const size = Array.isArray(body) ? body.length : 0;
    items.push(...asObjects(body, path));
    if (size < PAGE_SIZE) return items;
  }
}

/** Тело ответа как массив объектов; иначе — отказ разбора. */
export function asObjects(body: unknown, path: string): readonly RawObject[] {
  if (!Array.isArray(body)) {
    throw new GitlabError(`gitlab GET ${path}: ожидался массив в ответе`, 0);
  }
  return body.filter((item): item is RawObject =>
    typeof item === "object" && item !== null && !Array.isArray(item)
  );
}

/** Тело ответа как объект; иначе — отказ разбора. */
export function asObject(body: unknown, path: string): RawObject {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GitlabError(`gitlab GET ${path}: ожидался объект в ответе`, 0);
  }
  return body as RawObject;
}

/**
 * Текст отказа: метод, путь запроса и код с телом. Путь — логический,
 * без `/api/v4`: столько же говорит о запросе, а читается человеком.
 */
function failure(
  method: string,
  path: string,
  query: Readonly<Record<string, string>>,
  status: number,
  detail: string,
  options?: ErrorOptions,
): GitlabError {
  const params = new URLSearchParams(query).toString();
  const target = params === "" ? path : `${path}?${params}`;
  const body = detail.length > ERROR_BODY_LIMIT
    ? detail.slice(0, ERROR_BODY_LIMIT)
    : detail;
  return new GitlabError(
    `gitlab ${method} ${target} -> ${status}: ${body}`,
    status,
    options,
  );
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GitlabError(
      `gitlab GET ${path}: ответ не разбирается как JSON`,
      0,
      { cause: err },
    );
  }
}

/** URL-encoded путь проекта: `grp/repo` → `grp%2Frepo`. */
export function projectPath(project: string): string {
  return encodeURIComponent(project);
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
