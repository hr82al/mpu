/**
 * Подставной sl-back на петле для тестов: записывает разобранные
 * запросы и отвечает тем, чем решит тест. Общий для атома и команд
 * `mpu api` — у обоих проверка одна (форма запроса и разбор ответа), и
 * вторая копия сервера разошлась бы с первой.
 *
 * Файл подключают только тесты: в бинарь он не попадает, потому что из
 * `main.ts` недостижим (тот же приём, что у `../gitlab/testing.ts`).
 */

/** Запрос, как его увидел сервер. */
export interface CapturedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

/** Поднятый стенд: адрес, накопленные запросы и остановка. */
export interface FakeSlback {
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

/**
 * Поднимает стенд на 127.0.0.1; ответ выбирает `reply`, получая уже
 * накопленные запросы (номер вызова — их количество). Гасить
 * `await stop()` в `finally`: незакрытый сервер — красный санитайзер.
 */
export function startFakeSlback(
  reply: (seen: readonly CapturedRequest[]) => Response | Promise<Response>,
): FakeSlback {
  const seen: CapturedRequest[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      });
      return reply(seen);
    },
  );
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    seen,
    stop: () => server.shutdown(),
  };
}

/** Ответ логина с готовым токеном — самый частый первый вызов теста. */
export function loginReply(token = "T"): Response {
  return Response.json({ accessToken: token });
}
