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
    // Не терминал: тест, читающий stdin, по умолчанию в положении
    // пайпа — приглашения ко вводу в нём быть не должно.
    stdinIsTerminal: () => false,
    readConfigStore: () => Promise.resolve(undefined),
    writeConfigStore: mustNotTouch("writeConfigStore"),
    readAccessToken: () => Promise.resolve(undefined),
    writeAccessToken: mustNotTouch("writeAccessToken"),
    currentShell: () => undefined,
    appendFile: mustNotTouch("appendFile"),
    launchOpener: mustNotTouch("opener"),
    runLegacy: mustNotTouch("runLegacy"),
    runLegacyInteractive: mustNotTouch("runLegacyInteractive"),
    envFile: {
      // `get` отвечает «ключа нет», а не падает: с переездом конфигурации
      // в env-файл (2026-08-05, `platform/env-file.md`) чтение ключа стало
      // обычным шагом команды — резолв пути `xlsx` зовёт его до всякой
      // проверки источников, — и отсутствие ключа это штатный ответ, а не
      // касание запретного; `values` (перечисление ключей) — тот же
      // штатный ответ пустотой. Запись и обязательный ключ по-прежнему
      // падают: их тест обязан объявить сам.
      get: () => undefined,
      values: () => ({}),
      require: mustNotTouch("envFile.require"),
      set: mustNotTouch("envFile.set"),
    },
    openCacheDb: mustNotTouch("openCacheDb"),
    progress: mustNotTouch("progress"),
    ...overrides,
  };
}
