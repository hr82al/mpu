/**
 * `@mpu/base/access` — доступ к серверам на петле: интерфейс `LOOPBACK`,
 * пускаемые `Origin` и проверка токена `Authorization`. Описание каждого
 * имени — JSDoc у его определения.
 */

export {
  hasBearer,
  LOOPBACK,
  LOOPBACK_ORIGINS,
  Origins,
} from "./src/access.ts";
