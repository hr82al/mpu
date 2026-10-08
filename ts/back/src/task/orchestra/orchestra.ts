/**
 * Шаг оркестратора по всем проектам (`task-orchestrator.md`, «Шаг
 * проекта», «Параллельные проекты»). Снимок журналов и отметок — одной
 * транзакцией кэш-БД; нажатия — вне её: иначе роль, ставящая `busy`,
 * ждала бы шага. Труппа — проект в оркестраторе: помнит свои
 * уведомления и своих актёров между шагами.
 */

import type { CacheDb } from "@mpu/command";
import { configValue, TASK_MAX_BUSY } from "@mpu/command/config";
import { DECISIONS_LIMIT, decisionsText } from "../cmd_read.ts";
import { type Project, Projects } from "../project.ts";
import type { Role } from "../roles.ts";
import { Actor, Capacity, type Cue } from "./actor.ts";
import { Course, type Event } from "./course.ts";
import { partOf } from "./part.ts";
import type { Hands } from "./ports.ts";

/** Проект на момент снимка. */
interface Snapshot {
  readonly project: string;
  readonly course: Course;
  readonly roles: readonly Role[];
  readonly decisions: string;
}

/** Снимок всех проектов с ролями и предел занятых. */
interface Board {
  readonly snapshots: readonly Snapshot[];
  /** Ролей с отметкой `busy` по всем проектам. */
  readonly busy: number;
  readonly maxBusy: number;
}

/** Проект в оркестраторе. */
class Troupe {
  readonly #project: string;
  readonly #hands: Hands;
  readonly #actors = new Map<string, Actor>();
  readonly #told = new Set<string>();

  constructor(project: string, hands: Hands) {
    this.#project = project;
    this.#hands = hands;
  }

  /** Сколько ролей проекта ждут отметки после запуска или очистки. */
  pending(): number {
    return [...this.#actors.values()].filter((one) => one.isPending()).length;
  }

  async step(
    snapshot: Snapshot,
    capacity: Capacity,
    reread: (role: string) => Role,
  ): Promise<void> {
    const { course } = snapshot;
    for (const event of course.events(this.#hands.clock.now())) {
      await this.#tell(event);
    }
    if (course.isStopped()) return;
    for (const role of snapshot.roles) {
      const cue: Cue = {
        role,
        course,
        decisions: snapshot.decisions,
        capacity,
        reread: () => reread(role.name()),
      };
      await this.#actor(role.name()).step(cue);
    }
  }

  #actor(role: string): Actor {
    const known = this.#actors.get(role);
    if (known !== undefined) return known;
    const actor = new Actor(this.#project, partOf(role), this.#hands);
    this.#actors.set(role, actor);
    return actor;
  }

  async #tell(event: Event): Promise<void> {
    if (this.#told.has(event.key)) return;
    this.#told.add(event.key);
    await this.#hands.notices.notify(event.text);
  }
}

/** Оркестратор: труппы всех проектов и шаг по ним. */
export class Orchestra {
  readonly #hands: Hands;
  readonly #openDb: () => CacheDb;
  readonly #troupes = new Map<string, Troupe>();

  constructor(hands: Hands, openDb: () => CacheDb) {
    this.#hands = hands;
    this.#openDb = openDb;
  }

  /**
   * Шаг по каждому проекту с профилями ролей. Сбой одного проекта —
   * строка в лог, остальные шагают.
   */
  async step(): Promise<void> {
    const board = this.#board();
    const pending = [...this.#troupes.values()].reduce(
      (sum, troupe) => sum + troupe.pending(),
      0,
    );
    const capacity = new Capacity(board.maxBusy, board.busy + pending);
    for (const snapshot of board.snapshots) {
      const reread = (role: string) => this.#reread(snapshot.project, role);
      try {
        await this.#troupe(snapshot.project).step(snapshot, capacity, reread);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.#hands.notices.log(`${snapshot.project}: шаг: ${reason}`);
      }
    }
  }

  #troupe(project: string): Troupe {
    const known = this.#troupes.get(project);
    if (known !== undefined) return known;
    const troupe = new Troupe(project, this.#hands);
    this.#troupes.set(project, troupe);
    return troupe;
  }

  #board(): Board {
    using db = this.#openDb();
    const projects = Projects.open(db);
    let board: Board = { snapshots: [], busy: 0, maxBusy: 0 };
    db.transaction(() => {
      const all = projects.all().map(snapshotOf);
      board = {
        snapshots: all.filter((one) => one.roles.length > 0),
        busy: all.flatMap((one) => one.roles).filter((role) => role.isBusy())
          .length,
        maxBusy: maxBusyOf(configValue(db, TASK_MAX_BUSY.key)),
      };
    });
    return board;
  }

  #reread(project: string, role: string): Role {
    using db = this.#openDb();
    const found = Projects.open(db)
      .at(project)
      .roles()
      .all()
      .find((one) => one.name() === role);
    if (found === undefined) throw new Error(`роли ${project} ${role} нет`);
    return found;
  }
}

function snapshotOf(project: Project): Snapshot {
  const { messages, turn } = project.journal();
  return {
    project: project.name(),
    course: new Course(project.name(), messages, turn),
    roles: project.roles().all(),
    decisions: decisionsText(project.decisions("", DECISIONS_LIMIT)),
  };
}

/** Предел из ключа `task.max_busy`; не целое — умолчание ключа. */
function maxBusyOf(value: string | undefined): number {
  const fallback = Number(TASK_MAX_BUSY.fallback(undefined));
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : fallback;
}
