/**
 * Проекты канала и их журналы в кэш-БД (`task.md`, «Побочные эффекты»).
 * Проект — объект со своим журналом: кладёт сообщение, выводит ход,
 * чистит старые порции в транзакции записи. Таблицы — у этого модуля:
 * эталон схемы кэш-БД (`platform/store.md`) их не содержит.
 */

import type { CacheDb, SqlRow } from "@mpu/command";
import {
  DECIDING,
  type Kind,
  kindNamed,
  NO_TURN,
  OWNER,
  OWNER_ANSWER,
  RESUME,
  RULE,
  STOP,
  TASK,
  type Turn,
} from "./kind.ts";
import { TaskRefusal, TaskUsage } from "./refusal.ts";
import { Roles, ROLES_SCHEMA } from "./roles.ts";

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS task_projects (
    name       TEXT PRIMARY KEY,
    note       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    portion INTEGER NOT NULL,
    kind    TEXT NOT NULL,
    body    TEXT NOT NULL,
    at_ms   INTEGER NOT NULL,
    read    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS task_messages_project
    ON task_messages (project, portion)`,
];

/** Сколько порций журнал хранит (`task.history`). */
export interface Depth {
  /** Удаляет порции старше хранимых; текущая остаётся всегда. */
  prune(db: CacheDb, project: string, current: number): void;
}

/** `-1`: журнал не чистится. */
export const KEEP_ALL: Depth = { prune: () => {} };

/**
 * Хранит `portions` последних порций; `0` — то же, что `1`: только
 * текущая. Чистку переживают последняя редакция правила, последний
 * `owner` без ответа после него и действующий `stop` (последнее из
 * `stop`/`resume`): иначе действующее правило, открытый вопрос владельца
 * и остановка проекта молча пропали бы (`task.md`, «Инварианты»).
 */
export class Keeping implements Depth {
  readonly #portions: number;

  constructor(portions: number) {
    this.#portions = Math.max(portions, 1);
  }

  prune(db: CacheDb, project: string, current: number) {
    db.execute(
      `DELETE FROM task_messages WHERE project = ? AND portion <= ?
        AND id IS NOT (SELECT max(id) FROM task_messages
                       WHERE project = ? AND kind = ?)
        AND id IS NOT (SELECT max(id) FROM task_messages AS asked
                       WHERE project = ? AND kind = ?
                         AND NOT EXISTS (SELECT 1 FROM task_messages
                           WHERE project = ? AND kind = ? AND id > asked.id))
        AND id IS NOT (SELECT id FROM (SELECT id, kind FROM task_messages
                         WHERE project = ? AND kind IN (?, ?)
                         ORDER BY id DESC LIMIT 1)
                       WHERE kind = ?)`,
      project,
      current - this.#portions,
      project,
      RULE.word,
      project,
      OWNER.word,
      project,
      OWNER_ANSWER.word,
      project,
      STOP.word,
      RESUME.word,
      STOP.word,
    );
  }
}

/** Сообщение журнала, как оно лежит. */
export class Message {
  readonly id: number;
  readonly portion: number;
  readonly kind: Kind;
  readonly body: string;
  readonly at: number;
  readonly read: boolean;

  constructor(row: SqlRow) {
    this.id = Number(row.id);
    this.portion = Number(row.portion);
    this.kind = kindNamed(String(row.kind));
    this.body = String(row.body);
    this.at = Number(row.at_ms);
    this.read = Number(row.read) === 1;
  }

  /** Время записи ISO (UTC). */
  iso(): string {
    return new Date(this.at).toISOString();
  }

  /** Тело в строке списка: без хвостовых переводов строки. */
  line(): string {
    return this.body.replace(/\n+$/, "");
  }

  firstLine(): string {
    return this.body.split("\n")[0];
  }
}

/** Отбор сообщений по виду для `read`. */
export interface KindPick {
  admits(kind: Kind): boolean;
  /** Хвост отказа «нет сообщений»: пусто или ` вида X`. */
  readonly named: string;
}

/** Любой вид. */
export const ANY_KIND: KindPick = { admits: () => true, named: "" };

/** Только вид `kind`. */
export function onlyKind(kind: Kind): KindPick {
  return { admits: (one) => one === kind, named: ` вида ${kind.word}` };
}

/** Строка `status`. */
export interface StatusRow {
  readonly project: string;
  readonly portion: number;
  readonly turn: string;
  readonly last: string | null;
  readonly age_s: number | null;
  readonly unread: boolean;
  readonly note: string;
}

/** Строка `history`. */
export interface HistoryRow {
  readonly project: string;
  readonly portion: number;
  readonly kind: string;
  readonly at: string;
  readonly first_line: string;
}

/** Порция в `decisions`. */
export interface DecidedPortion {
  readonly portion: number;
  readonly items: readonly {
    readonly kind: string;
    readonly at: string;
    readonly text: string;
  }[];
}

/** Документ `decisions`. */
export interface Decisions {
  readonly rules: string | null;
  readonly portions: readonly DecidedPortion[];
}

/** Проекты канала в кэш-БД. */
export class Projects {
  readonly #db: CacheDb;

  private constructor(db: CacheDb) {
    this.#db = db;
  }

  /**
   * Открывает журнал: схема кэш-БД (права файла, `platform/store.md`) и
   * таблицы канала создаются, если их нет.
   */
  static open(db: CacheDb): Projects {
    db.bootstrap();
    for (const statement of [...SCHEMA, ...ROLES_SCHEMA]) db.execute(statement);
    return new Projects(db);
  }

  /**
   * Заводит проект или обновляет его заметку.
   *
   * @param note заметка; `null` — у нового пустая, у заведённого прежняя
   */
  setup(name: string, note: string | null, at: number) {
    this.#db.execute(
      `INSERT INTO task_projects (name, note, created_at)
        VALUES (?, coalesce(?, ''), ?)
        ON CONFLICT (name) DO UPDATE SET note = coalesce(?, note)`,
      name,
      note,
      at,
      note,
    );
  }

  /**
   * Проект по имени.
   *
   * @throws TaskUsage — проекта нет; текст подсказывает `setup`
   */
  at(name: string): Project {
    const rows = this.#db.query(
      "SELECT name, note FROM task_projects WHERE name = ?",
      name,
    );
    if (rows.length === 0) {
      throw new TaskUsage(
        `нет проекта ${name} — заведи: mpu ask task setup project: ${name}`,
      );
    }
    return new Project(this.#db, rows[0]);
  }

  /** Все проекты по имени. */
  all(): Project[] {
    return this.#db
      .query("SELECT name, note FROM task_projects ORDER BY name")
      .map((row) => new Project(this.#db, row));
  }
}

/** Проект: имя, заметка и журнал. */
export class Project {
  readonly #db: CacheDb;
  readonly #name: string;
  readonly #note: string;

  constructor(db: CacheDb, row: SqlRow) {
    this.#db = db;
    this.#name = String(row.name);
    this.#note = String(row.note);
  }

  /**
   * Постановка: открывает порцию N+1.
   *
   * @throws TaskRefusal — последняя постановка не отработана
   */
  post(body: string, at: number, depth: Depth) {
    const messages = this.#messages();
    const last = messages.at(-1);
    if (last?.kind === TASK) {
      throw new TaskRefusal(
        `порция ${last.portion} не отработана — заменить: ` +
          `mpu task post force project: ${this.#name} …`,
      );
    }
    this.#write(currentOf(messages) + 1, TASK, body, at, depth);
  }

  /**
   * Замена неотработанной постановки (`force`): номер не растёт.
   *
   * @throws TaskRefusal — последнее сообщение не постановка
   */
  replace(body: string, at: number, depth: Depth) {
    const last = this.#messages().at(-1);
    if (last?.kind !== TASK) {
      throw new TaskRefusal(
        `заменять нечего — последнее сообщение в ${this.#name} не постановка`,
      );
    }
    this.#write(last.portion, TASK, body, at, depth);
  }

  /**
   * Сообщение к текущей порции.
   *
   * @throws TaskUsage — порций ещё нет
   */
  attach(kind: Kind, body: string, at: number, depth: Depth) {
    const current = currentOf(this.#messages());
    if (current === 0) {
      throw new TaskUsage(
        `порций ещё нет — начни с mpu task post project: ${this.#name} …`,
      );
    }
    this.#write(current, kind, body, at, depth);
  }

  /**
   * `stop`/`resume` к текущей порции; порций нет — к порции 0, без
   * отказа: остановить можно и проект, где работа ещё не начата.
   */
  steer(kind: Kind, body: string, at: number, depth: Depth) {
    this.#write(currentOf(this.#messages()), kind, body, at, depth);
  }

  /**
   * Тело последнего сообщения отбора; `keep` — не помечать прочитанным.
   *
   * @throws TaskRefusal — таких сообщений нет
   */
  read(pick: KindPick, keep: boolean): string {
    const found = this.#messages()
      .filter((one) => pick.admits(one.kind))
      .at(-1);
    if (found === undefined) {
      throw new TaskRefusal(`в ${this.#name} нет сообщений${pick.named}`);
    }
    if (!keep) this.#markRead(found);
    return found.body;
  }

  /**
   * Последнее непрочитанное сообщение вида `kind`: помечает прочитанным
   * и отдаёт `found`, нет — `missing`.
   */
  take<T>(kind: Kind, found: (body: string) => T, missing: () => T): T {
    const unread = this.#messages()
      .filter((one) => one.kind === kind && !one.read)
      .at(-1);
    if (unread === undefined) return missing();
    this.#markRead(unread);
    return found(unread.body);
  }

  /** Строка `status` на момент `now`. */
  status(now: number): StatusRow {
    const messages = this.#messages();
    const last = messages.at(-1);
    return {
      project: this.#name,
      portion: currentOf(messages),
      turn: turnOf(messages).label(),
      last: last?.kind.word ?? null,
      age_s:
        last === undefined
          ? null
          : Math.max(0, Math.floor((now - last.at) / 1000)),
      unread: last !== undefined && !last.read,
      note: this.#note,
    };
  }

  /** Журнал от свежего к старому. */
  history(): HistoryRow[] {
    return this.#messages()
      .reverse()
      .map((one) => ({
        project: this.#name,
        portion: one.portion,
        kind: one.kind.word,
        at: one.iso(),
        first_line: one.firstLine(),
      }));
  }

  /** Имя проекта. */
  name(): string {
    return this.#name;
  }

  /** Журнал в порядке записи и ход по нему — для оркестратора. */
  journal(): { readonly messages: readonly Message[]; readonly turn: Turn } {
    const messages = this.#messages();
    return { messages, turn: turnOf(messages) };
  }

  /** Профили и отметки ролей проекта. */
  roles(): Roles {
    return new Roles(this.#db, this.#name);
  }

  /** Удаляет всё, кроме текущей порции. */
  clear() {
    const current = currentOf(this.#messages());
    this.#db.execute(
      "DELETE FROM task_messages WHERE project = ? AND portion < ?",
      this.#name,
      current,
    );
  }

  /**
   * Правила и решения: последняя редакция правила и `decision`, `owner`,
   * `owner-answer` последних `limit` порций, где есть что показать.
   *
   * @param query слово без учёта регистра; пустое — всё
   */
  decisions(query: string, limit: number): Decisions {
    const messages = this.#messages();
    const rule = messages.filter((one) => one.kind === RULE).at(-1);
    const wanted = query.toLowerCase();
    const shown = messages.filter(
      (one) =>
        DECIDING.includes(one.kind) && one.body.toLowerCase().includes(wanted),
    );
    return {
      rules: rule?.line() ?? null,
      portions: byPortion(shown).slice(-limit),
    };
  }

  #write(portion: number, kind: Kind, body: string, at: number, depth: Depth) {
    this.#db.transaction(() => {
      this.#db.execute(
        `INSERT INTO task_messages (project, portion, kind, body, at_ms)
          VALUES (?, ?, ?, ?, ?)`,
        this.#name,
        portion,
        kind.word,
        body,
        at,
      );
      depth.prune(this.#db, this.#name, portion);
    });
  }

  #markRead(message: Message) {
    this.#db.execute(
      "UPDATE task_messages SET read = 1 WHERE id = ?",
      message.id,
    );
  }

  #messages(): Message[] {
    return this.#db
      .query(
        `SELECT id, portion, kind, body, at_ms, read FROM task_messages
        WHERE project = ? ORDER BY id`,
        this.#name,
      )
      .map((row) => new Message(row));
  }
}

/** Номер текущей порции: максимальный; порций нет — 0. */
function currentOf(messages: readonly Message[]): number {
  return messages.reduce((max, one) => Math.max(max, one.portion), 0);
}

/** Ход — свёртка журнала: каждый вид сам меняет ход. */
function turnOf(messages: readonly Message[]): Turn {
  return messages.reduce((turn, one) => one.kind.after(turn), NO_TURN);
}

function byPortion(messages: readonly Message[]): DecidedPortion[] {
  const portions: { portion: number; items: DecidedPortion["items"][0][] }[] =
    [];
  for (const one of messages) {
    let group = portions.at(-1);
    if (group?.portion !== one.portion) {
      group = { portion: one.portion, items: [] };
      portions.push(group);
    }
    group.items.push({ kind: one.kind.word, at: one.iso(), text: one.line() });
  }
  return portions;
}
