/**
 * `@mpu/telegram/session` — живой клиент MTProto: сеанс по настройкам и
 * вход (`ts/docs/specs/platform/telegram-mtproto.md`, `telegram-login.md`).
 *
 * Отдельным входом от `@mpu/telegram`: за ним клиент `@mtcute/node` и 156 КБ
 * wasm криптографии, а потребитель — команда, вызываемая десятками раз за
 * сессию, — платит за них только на ветке, которой нужна сеть.
 */

export { openLoginClient } from "./src/login_client.ts";
export { openSession, type TelegramSession } from "./src/session.ts";
