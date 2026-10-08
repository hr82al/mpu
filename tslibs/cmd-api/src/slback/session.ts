/**
 * Сеанс sl-back над io команды (`docs/specs/platform/slback-http.md`): адрес
 * и креды — из env-файла по правилам `./config.ts`, кэш токена — файлом
 * `CommandIo`. Сам сеанс — кэш или логин, вызов под токеном — библиотека
 * `@mpu/slback` (`docs/specs/platform/tslibs-slback.md`).
 *
 * Отказ адреса и кред (`DomainError` из `./config.ts`) библиотека
 * пропускает тем же объектом, поэтому переводить здесь нечего.
 */

import {
  type Clock,
  openSlback as openSession,
  type SlbackSession,
} from "@mpu/slback";
import type { CommandIo } from "@mpu/command";
import { slbackBaseUrl, slbackCredentials } from "./config.ts";

/** Срез io команды: env-файл и обе стороны кэша токена. */
export type SlbackIo = Pick<
  CommandIo,
  "envFile" | "readTokenCache" | "writeTokenCache"
>;

/**
 * Сеанс sl-back команды; `now` — часы срока годности записи кэша (по
 * умолчанию — системные, у библиотеки).
 */
export function openSlback(io: SlbackIo, now?: Clock): SlbackSession {
  return openSession(
    {
      baseUrl: () => slbackBaseUrl(io.envFile),
      credentials: (overrides) => slbackCredentials(io.envFile, overrides),
      readTokenCache: () => io.readTokenCache(),
      writeTokenCache: (text) => io.writeTokenCache(text),
    },
    now,
  );
}
