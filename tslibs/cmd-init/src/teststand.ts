/**
 * Стенд сценариев `mpu init` (`docs/specs/init.md`): фейковые ответы
 * Portainer, Loki и Kaiten на одном сервере петли (`serveFetch`,
 * `@mpu/testing`, порт 0), env-файл и кэш-БД во временном каталоге, строки
 * пропусков шагов 3–5. Один на тесты пакета и сценарии через точку входа
 * приложения (`ts/`, вход `@mpu/cmd-init/testing`) — второй копии нет.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandIo, EnvFile } from "@mpu/command";
import { openCacheDb } from "@mpu/command/store";
import { makeFakeIo } from "@mpu/command/testing";
import { serveFetch } from "@mpu/testing";

/** Ключ Portainer стенда; секрет, которого не должно быть в выводе. */
export const API_KEY = "proba-portainer-key-K7x9Qz";

/** `status` по умолчанию 1 (доступен) — большинству тестов down не нужен. */
export function endpointsResponse(
  endpoints: ReadonlyArray<{ id: number; name: string; status?: number }>,
): Response {
  return Response.json(
    endpoints.map((e) => ({ Id: e.id, Name: e.name, Status: e.status ?? 1 })),
  );
}

/** Контейнер в ответе Portainer — поля, которые читает обход. */
export interface FakeContainer {
  readonly id: string;
  readonly names: readonly string[];
  readonly state: string;
  readonly image: string;
}

/** Ответ Portainer на список контейнеров endpoint'а. */
export function containersResponse(
  containers: readonly FakeContainer[],
): Response {
  return Response.json(
    containers.map((c) => ({
      Id: c.id,
      Names: c.names,
      State: c.state,
      Image: c.image,
    })),
  );
}

/**
 * Env-файл с готовыми значениями; `require` и `set` команда `init` звать
 * не должна — вызов ломает тест.
 */
export function envFileFake(
  values: Readonly<Record<string, string>> = {},
): EnvFile {
  return {
    get: (name) => values[name],
    require: () => {
      throw new Error("envFile.require must not be touched");
    },
    set: () => {
      throw new Error("envFile.set must not be touched");
    },
    values: () => ({ ...values }),
  };
}

/**
 * Окружение прогона. Шаг 5 по умолчанию отрабатывает успешно и потому
 * молчит: его отказы проверяются отдельными тестами, а в остальных он
 * только шумел бы в ожидаемом stderr.
 */
export function makeIo(
  dbPath: string,
  overrides: Partial<CommandIo> = {},
): CommandIo {
  return makeFakeIo({
    openCacheDb: () => openCacheDb(dbPath),
    ...overrides,
  });
}

/**
 * Строки шага 5 в неинтерактивном прогоне: спросить некого. Подсказка
 * про ключи печатается и здесь — сценарий узнаёт, что спрашивать
 * некого, от первого же вопроса, а не заранее
 * (`platform/line-prompt.md`).
 */
export const TELEGRAM_SKIPPED =
  "# telegram: ключей приложения нет; взять их — https://my.telegram.org/apps\n" +
  "# telegram: пропущено (нет TTY; заполни TELEGRAM_API_ID/HASH в .env вручную)\n";

/**
 * Строки шагов 3–5 при незаданных ключах и без терминала: прогревы
 * пропускаются, вход тоже — штатный исход для тестов, которые
 * проверяют шаги 1–2.
 *
 * Строку шага 5 печатает сам вход (с порции 95 шаг зовёт его напрямую,
 * а не подпроцессом), и в неинтерактивном прогоне она есть всегда:
 * терминала у теста нет, а молчаливого пропуска у входа не бывает
 * (`telegram-login.md`, инвариант 3).
 */
export const WARMUP_SKIPPED =
  "# loki: пропущено (LOKI_URL не задан)\n" +
  "# kaiten: пропущено (KITEN_API_KEY не задан)\n" +
  TELEGRAM_SKIPPED;

/** Кэш-БД во временном каталоге на время `fn`; каталог убирается. */
export async function withTempDb(
  fn: (dbPath: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await fn(`${dir}/mpu.db`, dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Пространства стенда: две доски, чтобы обход частей 2–3 был не вырожден. */
const STAND_SPACES = [
  {
    id: 101,
    title: "Разработка",
    archived: false,
    boards: [
      { id: 501, space_id: 101, title: "Основная доска" },
      { id: 502, space_id: 101, title: "Баги" },
    ],
  },
];

/** Дорожки досок стенда. */
const STAND_LANES: Readonly<Record<string, unknown[]>> = {
  "501": [
    { id: 9001, board_id: 501, title: "Обычные" },
    { id: 9002, board_id: 501, title: "Срочные" },
  ],
  "502": [{ id: 9101, board_id: 502, title: "Обычные" }],
};

/** Колонки досок стенда. */
const STAND_COLUMNS: Readonly<Record<string, unknown[]>> = {
  "501": [
    { id: 7001, board_id: 501, title: "Очередь", sort_order: 1 },
    { id: 7002, board_id: 501, title: "В работе", sort_order: 2 },
  ],
  "502": [{ id: 7101, board_id: 502, title: "Очередь", sort_order: 1 }],
};

/** Роли пользователей стенда. */
const STAND_ROLES = [
  { id: 11, name: "Разработка" },
  {
    id: 12,
    name: "Аналитика",
  },
];

/** Ответ series: два хоста, две пары (у одной записи сервиса нет). */
export const STAND_SERIES = {
  status: "success",
  data: [
    { host: "sl-1", compose_service: "api" },
    { host: "sl-2", compose_service: "api" },
    { host: "sl-1" },
  ],
};

const STAND_CONTAINERS: readonly FakeContainer[] = [
  { id: "c1", names: ["/sl-1-cli"], state: "running", image: "img" },
];

/** Сводки прогревов стенда — их же ждут тесты порядка и конкурентности. */
export const STAND_WARMUP_LINES =
  "# loki: 2 hosts, 2 (host, service) пар\n" +
  "# kaiten: 1 spaces, 2 boards, 3 lanes, 3 columns, 2 roles\n" +
  "# telegram: ключей приложения нет; взять их — https://my.telegram.org/apps\n" +
  "# telegram: пропущено (нет TTY; заполни TELEGRAM_API_ID/HASH в .env вручную)\n";

/** Доска из пути `/api/latest/boards/<id>/<что>`; путь не тот — undefined. */
export function boardOf(pathname: string, what: string): string | undefined {
  const match = new RegExp(`^/api/latest/boards/(\\d+)/${what}$`).exec(
    pathname,
  );
  return match === null ? undefined : match[1];
}

/**
 * Один фейковый стенд на все три источника: пути не пересекаются, а
 * тесту достаточно одного порта и одного `stop()`. `hook` подменяет
 * ответ по пути (вернул undefined — берётся ответ стенда по умолчанию).
 */
export function fakeStand(
  hook: (
    url: URL,
  ) => Response | Promise<Response | undefined> | undefined = () => undefined,
) {
  return serveFetch(async (req) => {
    const url = new URL(req.url);
    const hooked = await hook(url);
    if (hooked !== undefined) return hooked;
    if (url.pathname === "/api/endpoints") {
      return endpointsResponse([{ id: 1, name: "prod" }]);
    }
    if (url.pathname === "/api/endpoints/1/docker/containers/json") {
      return containersResponse(STAND_CONTAINERS);
    }
    if (url.pathname === "/loki/api/v1/series") {
      return Response.json(STAND_SERIES);
    }
    if (url.pathname === "/api/latest/spaces") {
      return Response.json(STAND_SPACES);
    }
    if (url.pathname === "/api/latest/user-roles") {
      return Response.json(STAND_ROLES);
    }
    const lanes = boardOf(url.pathname, "lanes");
    if (lanes !== undefined) return Response.json(STAND_LANES[lanes] ?? []);
    const columns = boardOf(url.pathname, "columns");
    if (columns !== undefined) {
      return Response.json(STAND_COLUMNS[columns] ?? []);
    }
    return new Response(null, { status: 404 });
  });
}

/** Окружение стенда: все три источника — на одном базовом URL. */
export function standEnv(baseUrl: string): EnvFile {
  return envFileFake({
    PORTAINER_API_KEY: API_KEY,
    PORTAINER_URL: baseUrl,
    LOKI_URL: baseUrl,
    KITEN_API_KEY: "proba-kiten-key-Q3w8Ee",
    KITEN_BASE_URL: baseUrl,
  });
}
