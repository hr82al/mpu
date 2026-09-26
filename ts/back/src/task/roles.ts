/**
 * Профили ролей проекта и их отметки в кэш-БД (`task-roles.md`). Роль —
 * объект с профилем (как её запустить) и отметкой (что она говорит о
 * себе); профиль и отметка хранятся раздельно: замена профиля отметку не
 * трогает.
 */

import type { CacheDb, SqlRow } from "../command/mod.ts";
import { TaskUsage } from "./refusal.ts";

/** Таблицы ролей: создаются вместе с журналом (`Projects.open`). */
export const ROLES_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS task_roles (
    project TEXT NOT NULL,
    role    TEXT NOT NULL,
    profile TEXT NOT NULL,
    PRIMARY KEY (project, role)
  )`,
  `CREATE TABLE IF NOT EXISTS task_marks (
    project TEXT NOT NULL,
    role    TEXT NOT NULL,
    mark    TEXT NOT NULL,
    at_ms   INTEGER NOT NULL,
    PRIMARY KEY (project, role)
  )`,
];

/** Роли проекта в порядке спеки; так их печатает `roles`. */
export const ROLE_NAMES = ["host", "exec"] as const;

/** Роль проекта (граница: ключ `role:` и строка таблицы). */
export type RoleName = typeof ROLE_NAMES[number];

/**
 * Роль по слову.
 *
 * @throws TaskUsage — слово не роль проекта; текст — готовый отказ
 */
export function roleNamed(word: string): RoleName {
  const found = ROLE_NAMES.find((one) => one === word);
  if (found !== undefined) return found;
  throw new TaskUsage(`роль ${word} — допустимо: ${ROLE_NAMES.join(", ")}`);
}

/** Отметка роли (граница: команды `busy`/`idle`). */
export type MarkWord = "busy" | "idle";

/** Профиль роли, как его подала строка: необязательное — умолчанием. */
export interface ProfileInput {
  readonly session?: string;
  readonly window?: string;
  readonly dir: string;
  readonly model?: string;
  readonly mode?: string;
  readonly "add-dir": readonly string[];
  readonly powers: string;
  readonly read: readonly string[];
}

/** Профиль роли: поля JSON-записи `roles` (`task-roles.md`, «Вывод»). */
export interface ProfileRecord {
  readonly session: string;
  readonly window: string;
  readonly dir: string;
  readonly model: string;
  readonly mode: string;
  readonly add_dir: readonly string[];
  readonly read: readonly string[];
  readonly powers: string;
}

/** Умолчания профиля (`task-roles.md`, «Профиль») — одна таблица. */
export const PROFILE_DEFAULTS = {
  session: "w",
  window: (project: string, role: RoleName) => `${project}-${role}`,
  model: "opus",
  mode: "auto",
} as const;

/** Профиль из входа строки: не названное — умолчание, не прежнее. */
export function profileOf(
  project: string,
  role: RoleName,
  input: ProfileInput,
): ProfileRecord {
  return {
    session: input.session ?? PROFILE_DEFAULTS.session,
    window: input.window ?? PROFILE_DEFAULTS.window(project, role),
    dir: input.dir,
    model: input.model ?? PROFILE_DEFAULTS.model,
    mode: input.mode ?? PROFILE_DEFAULTS.mode,
    add_dir: [...input["add-dir"]],
    read: [...input.read],
    powers: input.powers,
  };
}

/** Отметка роли: последнее значение и его время. */
interface Mark {
  /** Возраст на `now`, секунды; отметки не было — `null` (граница JSON). */
  ageAt(now: number): number | null;
  /** Слово JSON-записи; отметки не было — `null`. */
  word(): string | null;
  /** Отметка `idle`: роль свободна, её можно чистить. */
  isIdle(): boolean;
  /** Отметка `busy`, поставленная не раньше `at`. */
  busyFrom(at: number): boolean;
  /** С какого момента роль занята; не занята — `Infinity`. */
  busySince(): number;
}

/** Отметки не было. */
const NO_MARK: Mark = {
  ageAt: () => null,
  word: () => null,
  isIdle: () => false,
  busyFrom: () => false,
  busySince: () => Infinity,
};

class Marked implements Mark {
  readonly #word: string;
  readonly #at: number;

  constructor(word: string, at: number) {
    this.#word = word;
    this.#at = at;
  }

  ageAt(now: number): number {
    return Math.max(0, Math.floor((now - this.#at) / 1000));
  }

  word(): string {
    return this.#word;
  }

  isIdle(): boolean {
    return this.#word === "idle";
  }

  busyFrom(at: number): boolean {
    return this.#word === "busy" && this.#at >= at;
  }

  busySince(): number {
    return this.#word === "busy" ? this.#at : Infinity;
  }
}

/** Запись `roles end json`. */
export interface RoleRecord extends ProfileRecord {
  readonly role: string;
  readonly mark: string | null;
  readonly mark_age_s: number | null;
}

/** Роль проекта: профиль и отметка. */
export class Role {
  readonly #name: string;
  readonly #profile: ProfileRecord;
  readonly #mark: Mark;

  constructor(name: string, profile: ProfileRecord, mark: Mark) {
    this.#name = name;
    this.#profile = profile;
    this.#mark = mark;
  }

  /** Роль проекта: `host` или `exec`. */
  name(): string {
    return this.#name;
  }

  /** Профиль: как запускать роль. */
  profile(): ProfileRecord {
    return this.#profile;
  }

  /** Свободна ли роль по своей отметке (`idle`). */
  isIdle(): boolean {
    return this.#mark.isIdle();
  }

  /** Отметила ли роль `busy` не раньше `at`. */
  busyFrom(at: number): boolean {
    return this.#mark.busyFrom(at);
  }

  /** С какого момента роль занята по отметке; не занята — `Infinity`. */
  busySince(): number {
    return this.#mark.busySince();
  }

  /** Занята ли роль по своей отметке (`busy`). */
  isBusy(): boolean {
    return this.#mark.busySince() !== Infinity;
  }

  /** Запись на момент `now`. */
  record(now: number): RoleRecord {
    return {
      role: this.#name,
      mark: this.#mark.word(),
      mark_age_s: this.#mark.ageAt(now),
      ...this.#profile,
      add_dir: [...this.#profile.add_dir],
      read: [...this.#profile.read],
    };
  }
}

/** Роли одного проекта. Проект уже проверен (`Projects.at`). */
export class Roles {
  readonly #db: CacheDb;
  readonly #project: string;

  constructor(db: CacheDb, project: string) {
    this.#db = db;
    this.#project = project;
  }

  /**
   * Записывает профиль целиком вместо прежнего.
   *
   * @throws TaskUsage — каталог занят ролью другого проекта
   */
  put(role: RoleName, profile: ProfileRecord) {
    const holder = this.#holderOf(profile.dir);
    if (holder !== undefined) {
      throw new TaskUsage(
        `каталог ${profile.dir} уже у роли ${holder.project} ${holder.role}`,
      );
    }
    this.#db.execute(
      `INSERT INTO task_roles (project, role, profile) VALUES (?, ?, ?)
        ON CONFLICT (project, role) DO UPDATE SET profile = excluded.profile`,
      this.#project,
      role,
      JSON.stringify(profile),
    );
  }

  forget(role: RoleName) {
    this.#db.execute(
      "DELETE FROM task_roles WHERE project = ? AND role = ?",
      this.#project,
      role,
    );
  }

  /** Отметка вместо прежней: хранится только последняя. */
  mark(role: RoleName, word: MarkWord, at: number) {
    this.#db.execute(
      `INSERT INTO task_marks (project, role, mark, at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT (project, role)
        DO UPDATE SET mark = excluded.mark, at_ms = excluded.at_ms`,
      this.#project,
      role,
      word,
      at,
    );
  }

  /** Роли с профилем в порядке спеки; без профиля — нет. */
  all(): Role[] {
    const rows = this.#db.query(
      `SELECT r.role, r.profile, m.mark, m.at_ms FROM task_roles AS r
        LEFT JOIN task_marks AS m ON m.project = r.project AND m.role = r.role
        WHERE r.project = ?`,
      this.#project,
    );
    return ROLE_NAMES.flatMap((name) =>
      rows.filter((row) => row.role === name).map(roleOf)
    );
  }

  /** Роль другого проекта с каталогом `dir`. */
  #holderOf(dir: string): { project: string; role: string } | undefined {
    const [row] = this.#db.query(
      `SELECT project, role FROM task_roles
        WHERE project <> ? AND json_extract(profile, '$.dir') = ?`,
      this.#project,
      dir,
    );
    if (row === undefined) return undefined;
    return { project: String(row.project), role: String(row.role) };
  }
}

function roleOf(row: SqlRow): Role {
  // Профиль пишет только `put` из `ProfileRecord`: форма строки — его.
  const profile = JSON.parse(String(row.profile)) as ProfileRecord;
  const mark = row.mark === null
    ? NO_MARK
    : new Marked(String(row.mark), Number(row.at_ms));
  return new Role(String(row.role), profile, mark);
}
