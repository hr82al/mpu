/**
 * `@mpu/slback/testing` — подставной sl-back на петле для тестов библиотеки
 * и её потребителя. Отдельной точкой от `@mpu/slback`: программе
 * потребителя стенд не нужен, а тянет он `@mpu/testing`.
 */

export {
  type CapturedRequest,
  type FakeSlback,
  loginReply,
  startFakeSlback,
} from "./src/testing.ts";
