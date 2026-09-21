/**
 * Файл правил подтверждения (`platform/policy.md`, «Хранение», «Посев»):
 * SQLite `policy.db`, прочитанный набор и его сверка с файлом перед
 * каждым решением.
 */

import { DatabaseSync } from "node:sqlite";
import { BUSY_TIMEOUT_MS } from "../store/mod.ts";
import { RulePath } from "./path.ts";
import { Rule, Rules, type Ruling } from "./rules.ts";
import { type RuleEntry, type Verdict, verdictNamed } from "./verdict.ts";

/**
 * Файл правил нельзя открыть, прочитать или записать. Текст — готовый
 * отказ строки; решения `allow` из такого файла не бывает.
 */
export class PolicyError extends Error {
  override name = "PolicyError";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  path TEXT PRIMARY KEY,
  verdict TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seeded (
  path TEXT PRIMARY KEY
);`;

/** Набор правил в файле: сам читает, сверяет и пишет. */
export class RuleBook implements Disposable {
  readonly #db: DatabaseSync;
  #rules: Rules = new Rules([]);
  /** Версия файла, из которой прочитан `#rules` (`PRAGMA data_version`). */
  #version = -1;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Открывает файл правил: схема, посев невиданных путей, чтение.
   *
   * @param file путь `policy.db`; `undefined` — каталога состояния нет
   * @param seeds посевные правила
   * @throws PolicyError — файл не открылся или не читается
   */
  static open(file: string | undefined, seeds: readonly Rule[]): RuleBook {
    if (file === undefined) {
      throw new PolicyError(
        "правила подтверждения: каталог состояния не задан (нет HOME)",
      );
    }
    return guarded(() => {
      // Путь без каталога — файл в текущем, создавать нечего.
      const cut = file.lastIndexOf("/");
      if (cut > 0) Deno.mkdirSync(file.slice(0, cut), { recursive: true });
      const db = new DatabaseSync(file);
      const book = new RuleBook(db);
      try {
        book.#prepare(seeds);
      } catch (err) {
        db.close();
        throw err;
      }
      return book;
    });
  }

  /** Решение для пути строки — по файлу, каким он стал к этому моменту. */
  decide(links: readonly string[]): Ruling {
    return guarded(() => {
      this.#fresh();
      return this.#rules.decide(links);
    });
  }

  /** Правила файла по пути правила. */
  list(): RuleEntry[] {
    return guarded(() => {
      this.#fresh();
      return this.#rules.list();
    });
  }

  /** Записывает правило (заменяет прежнее на том же пути). */
  set(path: RulePath, verdict: Verdict) {
    guarded(() => {
      this.#db.prepare(
        "INSERT OR REPLACE INTO rules (path, verdict) VALUES (?, ?)",
      ).run(path.text(), verdict.word);
      this.#load();
    });
  }

  /** Удаляет правило; правила не было — ничего. */
  forget(path: RulePath) {
    guarded(() => {
      this.#db.prepare("DELETE FROM rules WHERE path = ?").run(path.text());
      this.#load();
    });
  }

  [Symbol.dispose]() {
    this.#db.close();
  }

  #prepare(seeds: readonly Rule[]) {
    // Ожидание занятого файла — внутри SQLite, а не сон в коде: два
    // одновременных старта с посевом иначе получили бы «database is
    // locked» вместо правил. Значение общее с кэш-БД.
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec(SCHEMA);
    this.#seed(seeds);
    this.#load();
  }

  /**
   * Посев: путь, который посев ещё ни разу не видел, получает правило;
   * виденный — нет, даже если правило с него сняли (`forget:`).
   * Прежде записанное человеком правило посев не заменяет.
   */
  #seed(seeds: readonly Rule[]) {
    if (this.#unseen(seeds).length === 0) return;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      // Перепроверка под блокировкой: другой процесс мог посеять и
      // человек — снять правило, пока этот читал список виденного.
      for (const seed of this.#unseen(seeds)) {
        const { path, verdict } = seed.entry();
        this.#db.prepare(
          "INSERT OR IGNORE INTO rules (path, verdict) VALUES (?, ?)",
        ).run(path, verdict);
        this.#db.prepare("INSERT INTO seeded (path) VALUES (?)").run(path);
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  #unseen(seeds: readonly Rule[]): Rule[] {
    const seen = new Set(
      this.#db.prepare("SELECT path FROM seeded").all().map((row) =>
        String(row.path)
      ),
    );
    return seeds.filter((seed) => !seen.has(seed.entry().path));
  }

  /** Перечитывает правила, если файл изменил другой процесс. */
  #fresh() {
    if (this.#fileVersion() !== this.#version) this.#load();
  }

  #load() {
    // Версия — до чтения строк: запись другого процесса между ними
    // оставит прочитанное устаревшим, но с устаревшей же версией, и
    // следующее решение его перечитает.
    const version = this.#fileVersion();
    const rows = this.#db.prepare("SELECT path, verdict FROM rules").all();
    this.#rules = new Rules(
      rows.map((row) =>
        new Rule(
          RulePath.parse(String(row.path)),
          verdictNamed(String(row.verdict)),
        )
      ),
    );
    this.#version = version;
  }

  /**
   * Версия файла глазами этого соединения: меняется, когда запись
   * зафиксировал другой процесс. Свои записи её не меняют — их
   * прочитанное обновляет сама запись.
   */
  #fileVersion(): number {
    return Number(this.#db.prepare("PRAGMA data_version").get()?.data_version);
  }
}

/** Любой сбой файла правил — отказ строки с причиной. */
function guarded<T>(act: () => T): T {
  try {
    return act();
  } catch (err) {
    if (err instanceof PolicyError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new PolicyError(`правила подтверждения: ${reason}`, { cause: err });
  }
}
