/**
 * `@mpu/gitlab/testing` — фейковый GitLab на петле для тестов библиотеки и
 * её потребителя. Отдельной точкой от `@mpu/gitlab`: программе потребителя
 * стенд не нужен, а тянет он `@mpu/testing`.
 */

export {
  type CapturedRequest,
  type FakeGitlab,
  startFakeGitlab,
} from "./src/testing.ts";
