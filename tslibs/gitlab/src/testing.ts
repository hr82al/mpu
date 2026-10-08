/**
 * Фейковый GitLab на петле для тестов модуля: записывает разобранные
 * запросы и отвечает тем, чем решит тест. Общий для транспорта
 * (`http.test.ts`), резолва (`resolve.test.ts`) и команд `mr` потребителя:
 * у всех проверка одна — форма отправленного запроса и разбор ответа, — и
 * вторая копия сервера разошлась бы с первой.
 *
 * Наружу выходит входом `@mpu/gitlab/testing`, а не `@mpu/gitlab`: в
 * программу потребителя стенд не попадает.
 */

import { serveFetch } from "@mpu/testing";

/** Запрос, как его увидел сервер. */
export interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly accept: string | null;
  readonly contentType: string | null;
  readonly privateToken: string | null;
  readonly body: string;
}

/** Поднятый стенд: адрес, накопленные запросы и остановка. */
export interface FakeGitlab {
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

/**
 * Поднимает стенд на 127.0.0.1; ответ выбирает `reply`, получая уже
 * накопленные запросы (номер вызова — их количество). Гасить
 * `await stop()` в `finally`: незакрытый сервер держит процесс.
 */
export async function startFakeGitlab(
  reply: (seen: readonly CapturedRequest[]) => Response | Promise<Response>,
): Promise<FakeGitlab> {
  const seen: CapturedRequest[] = [];
  const server = await serveFetch(async (req) => {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      accept: req.headers.get("accept"),
      contentType: req.headers.get("content-type"),
      privateToken: req.headers.get("private-token"),
      body: await req.text(),
    });
    return reply(seen);
  });
  return {
    baseUrl: server.baseUrl,
    seen,
    stop: () => server.stop(),
  };
}
