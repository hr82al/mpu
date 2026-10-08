/**
 * Вход `@mpu/cmd-init/testing`: стенд сценариев `mpu init` — фейковые
 * Portainer, Loki и Kaiten на петле, env-файл, кэш-БД во временном
 * каталоге, строки пропусков шагов. Его берут сценарии через точку входа
 * приложения (`ts/`); копии стенда у них нет.
 */

export {
  API_KEY,
  containersResponse,
  endpointsResponse,
  envFileFake,
  type FakeContainer,
  fakeStand,
  makeIo,
  STAND_SERIES,
  STAND_WARMUP_LINES,
  standEnv,
  TELEGRAM_SKIPPED,
  WARMUP_SKIPPED,
  withTempDb,
} from "./src/teststand.ts";
