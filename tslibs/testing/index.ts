/**
 * `@mpu/testing` — подставной HTTP-сервер на петле для тестов `ts/` и
 * пакетов `tslibs/*` (`ts/docs/specs/platform/tslibs-testing.md`).
 *
 * Без `vitest`: точку берёт и обычный скрипт (smoke `ts/`), а `vitest` вне
 * своего раннера бросает при загрузке. Пойманная ошибка — `@mpu/testing/thrown`.
 * Описание каждого имени — JSDoc у его определения.
 */

export {
  closedPort,
  type FakeHttp,
  type FetchHandler,
  listenLoopback,
  serveFetch,
  type Tls,
} from "./src/http.ts";
