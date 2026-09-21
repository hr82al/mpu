/**
 * Общий фейк окружения для тестов. Тестов, которым нужен `CommandIo`,
 * уже трое, и каждый заводил свою заглушку — расходились не только
 * умолчания, но и поведение неожидаемого обращения.
 *
 * Модуль подключают только тесты: в бинарь он не попадает, потому что
 * из `main.ts` недостижим.
 */

import { DatabaseSync } from "node:sqlite";
import {
  type Answer,
  type CacheDb,
  type CommandIo,
  NEVER_STOPPED,
  NO_ONE,
  type Prompt,
  type SqlRow,
} from "../command/mod.ts";
import { SCHEMA_STATEMENTS } from "../store/schema.ts";

/**
 * Окружение, где разрешено ровно то, что тест перечислил. Всё
 * остальное — падение с именем тронутой операции: тест, случайно
 * ушедший в файловую систему, должен краснеть, а не тихо работать.
 */
/**
 * Подставной спрошенный: отвечает заготовленным и помнит вопросы.
 * Один на все тесты, потому что копия в каждом разъехалась бы ровно
 * там, где важна одинаковость, — в том, что считать отсутствием ответа.
 */
export function promptAnswering(
  answers: {
    /** Ответ на видимый вопрос; не задан — спросить некого. */
    readonly line?: string;
    /** Ответ на скрытый вопрос; не задан — спросить некого. */
    readonly secret?: string;
  } = {},
): Prompt & {
  /** Заданные вопросы по порядку: вид и текст. */
  readonly asked: { kind: "line" | "secret"; question: string }[];
  /** Тексты, которые просили положить в буфер обмена. */
  readonly copied: string[];
} {
  const asked: { kind: "line" | "secret"; question: string }[] = [];
  const copied: string[] = [];
  const reply = <T>(
    kind: "line" | "secret",
    question: string,
    answer: Answer<T>,
    text: string | undefined,
  ): Promise<T> => {
    asked.push({ kind, question });
    return Promise.resolve(
      text === undefined ? answer.absent() : answer.given(text),
    );
  };
  return {
    asked,
    copied,
    line: (question, answer) => reply("line", question, answer, answers.line),
    secret: (question, answer) =>
      reply("secret", question, answer, answers.secret),
    copy: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
  };
}

/**
 * Спрошенный с очередью ответов: каждый вопрос забирает следующий,
 * очередь кончилась — спросить некого. Нужен сценариям, которые
 * спрашивают несколько раз подряд.
 */
export function promptQueue(answers: (string | undefined)[]): Prompt {
  const next = <T>(answer: Answer<T>): Promise<T> => {
    const text = answers.shift();
    return Promise.resolve(
      text === undefined ? answer.absent() : answer.given(text),
    );
  };
  return {
    line: (_question, answer) => next(answer),
    secret: (_question, answer) => next(answer),
    copy: () => Promise.resolve(),
  };
}

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
    // Остановки у теста по умолчанию нет: тест, которому она нужна,
    // объявляет свой сигнал сам.
    signal: NEVER_STOPPED,
    // Ширины нет: тест, которому важна вёрстка по ширине, объявляет её
    // сам — как и терминальность.
    consoleColumns: () => undefined,
    stderrIsTerminal: () => false,
    // Заметки журнала тест по умолчанию глотает: они не наблюдаемая
    // поверхность команды, а запись о вызове.
    note: () => {},
    // Спросить в прогоне тестов некого, и команда обязана это
    // заметить; тест, которому нужен ответ, объявляет свой порт сам.
    prompt: NO_ONE,
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
    // стало обычным шагом, и «хранилища нет» это штатный ответ, а не
    // касание запретного (то же рассуждение, что у `envFile.get`). Файловой
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
