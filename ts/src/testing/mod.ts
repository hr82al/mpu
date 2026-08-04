/**
 * Общий фейк окружения для тестов. Тестов, которым нужен `CommandIo`,
 * уже трое, и каждый заводил свою заглушку — расходились не только
 * умолчания, но и поведение неожидаемого обращения.
 *
 * Модуль подключают только тесты: в бинарь он не попадает, потому что
 * из `main.ts` недостижим.
 */

import type { CommandIo } from "../command/mod.ts";

/**
 * Окружение, где разрешено ровно то, что тест перечислил. Всё
 * остальное — падение с именем тронутой операции: тест, случайно
 * ушедший в файловую систему, должен краснеть, а не тихо работать.
 */
export function makeFakeIo(overrides: Partial<CommandIo> = {}): CommandIo {
  const mustNotTouch = (what: string) => () => {
    throw new Error(`${what} must not be touched`);
  };
  return {
    env: () => undefined,
    cwd: () => "/nowhere",
    readFile: mustNotTouch("readFile"),
    readTextFile: mustNotTouch("readTextFile"),
    readTextStdin: mustNotTouch("stdin"),
    readConfigStore: () => Promise.resolve(undefined),
    writeConfigStore: mustNotTouch("writeConfigStore"),
    readAccessToken: () => Promise.resolve(undefined),
    writeAccessToken: mustNotTouch("writeAccessToken"),
    currentShell: () => undefined,
    appendFile: mustNotTouch("appendFile"),
    launchOpener: mustNotTouch("opener"),
    runLegacy: mustNotTouch("runLegacy"),
    envFile: {
      get: mustNotTouch("envFile"),
      require: mustNotTouch("envFile"),
      set: mustNotTouch("envFile"),
    },
    ...overrides,
  };
}
