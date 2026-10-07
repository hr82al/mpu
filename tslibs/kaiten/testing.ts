/**
 * `@mpu/kaiten/testing` — фейковый Kaiten на петле для тестов библиотеки и
 * её потребителя. Отдельной точкой от `@mpu/kaiten`: программе потребителя
 * стенд не нужен, а тянет он `@mpu/testing`.
 */

export {
  type CapturedRequest,
  type FakeKaiten,
  startFakeKaiten,
} from "./src/testing.ts";
