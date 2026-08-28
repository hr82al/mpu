/**
 * Общий фейк окружения для тестов. Тестов, которым нужен `CommandIo`,
 * уже трое, и каждый заводил свою заглушку — расходились не только
 * умолчания, но и поведение неожидаемого обращения.
 *
 * Модуль подключают только тесты: в бинарь он не попадает, потому что
 * из `main.ts` недостижим.
 */

import { DatabaseSync } from "node:sqlite";
import type { CacheDb, CommandIo, SqlRow } from "../command/mod.ts";
import { SCHEMA_STATEMENTS } from "../store/schema.ts";

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
    readRegularFile: mustNotTouch("readRegularFile"),
    readTextFile: mustNotTouch("readTextFile"),
    readStdin: mustNotTouch("stdin"),
    // Не терминал: тест, читающий stdin, по умолчанию в положении
    // пайпа — приглашения ко вводу в нём быть не должно.
    stdinIsTerminal: () => false,
    // Не терминал и stdout: команда с несколькими видами вывода по
    // умолчанию отдаёт машиночитаемый — тест, которому нужен наглядный,
    // объявляет это сам.
    stdoutIsTerminal: () => false,
    stderrIsTerminal: () => false,
    // Заметки журнала тест по умолчанию глотает: они не наблюдаемая
    // поверхность команды, а запись о вызове.
    note: () => {},
    // Терминала у теста по умолчанию нет: вопрос человеку в прогоне
    // тестов задать некому, и команда обязана это заметить.
    openTerminal: () => Promise.resolve(undefined),
    readAccessToken: () => Promise.resolve(undefined),
    writeAccessToken: mustNotTouch("writeAccessToken"),
    // Холодный токен-кэш sl-back — штатный путь каждой команды `api`,
    // поэтому чтение отвечает «записи нет», а не падает. Запись падает:
    // тест, гоняющий логин, обязан объявить приёмник сам — заодно видно,
    // что в кэш ушло.
    readTokenCache: () => Promise.resolve(undefined),
    writeTokenCache: mustNotTouch("writeTokenCache"),
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
    // Пустая кэш-БД в памяти, а не запрет: с переездом предпочтений в
    // таблицу `config` (2026-08-27, `platform/config.md`) чтение ключа
    // стало обычным шагом — маршрут `legacy` зовёт его до всякого
    // запуска, — и «хранилища нет» это штатный ответ, а не касание
    // запретного (то же рассуждение, что у `envFile.get`). Файловой
    // системы такая база не касается; тест, которому нужно доказать,
    // что команда в базу не ходит, объявляет свой бросающий порт.
    openCacheDb: fakeConfigDb(),
    progress: mustNotTouch("progress"),
    openRemoteOutput: mustNotTouch("openRemoteOutput"),
    ...overrides,
  };
}

/**
 * Порт `openCacheDb` поверх кэш-БД в памяти: чем тест подменяет
 * хранилище, когда команде нужен ключ конфига или алиас
 * (`platform/config.md`).
 *
 * Схема настоящая, из канала `store/schema.ts`, и запросы идут через
 * настоящий SQLite: подделка таблицы прошла бы мимо ровно того дефекта,
 * ради которого предпочтения переехали в БД, — «читаем не оттуда, и
 * молча получаются умолчания».
 *
 * Возвращается **фабрика**, отдающая одну и ту же базу при каждом
 * вызове, а `[Symbol.dispose]` у ручки пуст: `using db =
 * io.openCacheDb()` внутри команды не должен закрывать базу, которую
 * тест держит между вызовами, — иначе `alias add` и следующий за ним
 * `alias ls` разговаривали бы с разными базами, а незакрытые
 * соединения копились бы на весь прогон.
 *
 * Схема создаётся только `bootstrap()` — как на чистой машине; с
 * непустыми `values` он зовётся сразу, потому что записать ключ иначе
 * некуда.
 */
export function fakeConfigDb(
  values: Readonly<Record<string, string>> = {},
): () => CacheDb {
  const db = new DatabaseSync(":memory:");
  const handle: CacheDb = {
    path: ":memory:",
    bootstrap: () => {
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    },
    execute: (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
    query: (sql, ...params) =>
      db.prepare(sql).all(...params) as readonly SqlRow[],
    // Транзакция настоящая: тест, проверяющий откат прерванной записи,
    // должен видеть откат, а не молчаливое «всё прошло».
    transaction: <T>(body: () => T): T => {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    [Symbol.dispose]: () => {},
  };
  const entries = Object.entries(values);
  if (entries.length > 0) {
    handle.bootstrap();
    for (const [key, value] of entries) {
      db.prepare("INSERT INTO config (key, value) VALUES (?, ?)")
        .run(key, value);
    }
  }
  return () => handle;
}
