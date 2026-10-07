/**
 * Фейковый Kaiten на петле для тестов библиотеки и её потребителя
 * (`@mpu/kaiten/testing`): записывает разобранные запросы и отвечает тем,
 * чем решит тест. Общий для тестов транспорта и каталогов: у всех
 * проверка одна и та же — форма отправленного запроса и разбор ответа, —
 * и вторая копия сервера разошлась бы с первой.
 *
 * Отдельной точкой от `@mpu/kaiten`: в программу потребителя стенд не
 * попадает, если её код его не импортирует.
 */

import { serveFetch } from "@mpu/testing";

/** Запрос, как его увидел сервер: форма отправленного проверяется по ней. */
export interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly contentType: string | null;
  readonly accept: string | null;
  readonly authorization: string | null;
  readonly body: string;
}

/** Поднятый стенд: адрес, накопленные запросы и остановка. */
export interface FakeKaiten {
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

/**
 * Поднимает стенд на 127.0.0.1; ответ выбирает `reply`, получая уже
 * накопленные запросы (номер попытки — их количество). Гасить
 * `await stop()` в `finally`: незакрытый сервер держит процесс.
 */
export async function startFakeKaiten(
  reply: (seen: readonly CapturedRequest[]) => Response | Promise<Response>,
): Promise<FakeKaiten> {
  const seen: CapturedRequest[] = [];
  const server = await serveFetch(async (req) => {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      contentType: req.headers.get("content-type"),
      accept: req.headers.get("accept"),
      authorization: req.headers.get("authorization"),
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
