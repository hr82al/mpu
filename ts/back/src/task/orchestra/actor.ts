/**
 * Роль проекта в оркестраторе (`task-orchestrator.md`, «Шаг проекта»,
 * «Запуск роли», «Очистка роли»). Актёр помнит своё между шагами: фазу
 * ожидания со сроком, счёт неудач подряд и выданные уведомления. Шаг
 * ожиданий не ждёт: фаза проверяется на каждом шаге и сразу после
 * действия, открывшего её.
 */

import type { ProfileRecord, Role } from "../roles.ts";
import { type Course, HOUR_MS, type Move } from "./course.ts";
import { Letter, RESUME_LINE } from "./letter.ts";
import type { Part } from "./part.ts";
import type { Hands, Place } from "./ports.ts";
import { CLAUDE_COMMAND, Screen } from "./signs.ts";

/** Срок каждого ожидания: запуска, простоя после `/clear`, `busy`. */
const WAIT_MS = 60_000;
/** Пауза между набором и Enter. */
const ENTER_PAUSE_MS = 2_000;
/** Неудач подряд до остановки роли. */
const ATTEMPTS = 3;
/** Как вернуть остановленную роль (решение хоста T3). */
const RESTORE = "вернуть: systemctl --user restart mpu";

/** Места под занятые роли на один шаг (`task.max_busy`). */
export class Capacity {
  readonly #max: number;
  #used: number;

  /**
   * @param max предел одновременно занятых ролей
   * @param used занято сейчас: отметки `busy` и роли в ожидании
   */
  constructor(max: number, used: number) {
    this.#max = max;
    this.#used = used;
  }

  /** Занять место; мест нет — `false`, действие ждёт следующего шага. */
  take(): boolean {
    if (this.#used >= this.#max) return false;
    this.#used += 1;
    return true;
  }
}

/** Что шаг проекта сообщает роли. */
export interface Cue {
  /** Профиль и отметка на момент снимка. */
  readonly role: Role;
  /** Ход проекта по журналу на момент снимка. */
  readonly course: Course;
  /** Вывод `decisions` проекта. */
  readonly decisions: string;
  readonly capacity: Capacity;
  /** Роль, перечитанная из базы: её отметка после снимка. */
  reread(): Role;
}

/** Фаза роли: что делает шаг, пока она длится. */
interface Phase {
  /** Занимает ли место предела, пока роль не отметилась `busy`. */
  readonly pending: boolean;
  step(actor: Actor, cue: Cue): Promise<void>;
}

/** Ожидания нет: шаг решает по окну, модели и ходу. */
const RESTING: Phase = {
  pending: false,
  step: (actor, cue) => actor.decide(cue),
};

/** Роль остановлена тремя неудачами: до перезапуска службы — ничего. */
const HALTED: Phase = {
  pending: false,
  step: () => Promise.resolve(),
};

/** Роль проекта: окно, отметка, запуск и очистка. */
export class Actor {
  readonly #project: string;
  readonly #part: Part;
  readonly #hands: Hands;
  #phase: Phase = RESTING;
  #failures = 0;
  readonly #told = new Set<string>();

  constructor(project: string, part: Part, hands: Hands) {
    this.#project = project;
    this.#part = part;
    this.#hands = hands;
  }

  /** Занимает ли роль место предела своим ожиданием. */
  isPending(): boolean {
    return this.#phase.pending;
  }

  step(cue: Cue): Promise<void> {
    return this.#phase.step(this, cue);
  }

  /**
   * Шаг без ожидания: нет окна или в нём не Claude — запуск; модель не
   * та — `/model`; есть ход и роль свободна — очистка; занята без
   * движения больше часа — уведомление.
   */
  async decide(cue: Cue): Promise<void> {
    const profile = cue.role.profile();
    const place = placeOf(profile);
    const command = await this.#hands.windows.command(place);
    if (command !== CLAUDE_COMMAND) {
      return this.#launch(cue, place, command !== undefined);
    }
    if (!cue.role.isIdle()) return this.#watchBusy(cue);
    const screen = await this.#screen(place);
    if (screen.differsFrom(profile.model)) {
      return this.#switchModel(place, profile.model);
    }
    if (this.#move(cue).due) await this.#clear(cue, place);
  }

  /** Проверка запуска: признаки на экране, диалог доверия, срок. */
  async checkLaunch(cue: Cue, launch: Launching): Promise<void> {
    const profile = cue.role.profile();
    const place = placeOf(profile);
    const screen = await this.#screen(place);
    if (screen.asksTrust()) {
      this.#phase = new Trusting(launch.message);
      return this.#tell(
        `trust@${launch.deadline}`,
        `${this.#who()}: подтвердите доверие в окне ${profile.window}`,
      );
    }
    if (launched(screen, launch.message, profile)) return this.#succeed();
    if (this.#hands.clock.now() < launch.deadline) return;
    await this.#hands.windows.close(place);
    await this.#fail("не запускается");
  }

  /** Диалог доверия снят человеком — роль запущена; окна нет — сначала. */
  async checkTrust(cue: Cue, message: string): Promise<void> {
    const profile = cue.role.profile();
    const place = placeOf(profile);
    const command = await this.#hands.windows.command(place);
    if (command !== CLAUDE_COMMAND) {
      this.#phase = RESTING;
      return;
    }
    const screen = await this.#screen(place);
    if (launched(screen, message, profile)) this.#succeed();
  }

  /** После `/clear`: дождаться простоя, сверить модель, дать сообщение. */
  async checkCleared(cue: Cue, deadline: number): Promise<void> {
    const profile = cue.role.profile();
    const place = placeOf(profile);
    const screen = await this.#screen(place);
    if (screen.isWorking()) {
      if (this.#hands.clock.now() >= deadline) await this.#fail("не будится");
      return;
    }
    if (screen.differsFrom(profile.model)) {
      return this.#switchModel(place, profile.model);
    }
    const letter = await this.#write(cue, [this.#move(cue).line()]);
    await this.#say(place, letter.message());
    const since = this.#hands.clock.now();
    this.#phase = new Waking(since + WAIT_MS, since);
    await this.#phase.step(this, cue);
  }

  /** После сообщения: роль отметилась `busy` — разбужена. */
  async checkWoken(cue: Cue, waking: Waking): Promise<void> {
    if (cue.reread().busyFrom(waking.since)) return this.#succeed();
    if (this.#hands.clock.now() < waking.deadline) return;
    await this.#fail("не будится");
  }

  /** После `/model`: модель не сменилась — окно закрыть, шаг запустит. */
  async checkModel(cue: Cue): Promise<void> {
    const profile = cue.role.profile();
    const place = placeOf(profile);
    this.#phase = RESTING;
    const screen = await this.#screen(place);
    if (screen.differsFrom(profile.model)) {
      await this.#hands.windows.close(place);
    }
  }

  async #launch(cue: Cue, place: Place, exists: boolean): Promise<void> {
    if (!cue.capacity.take()) return;
    const { windows } = this.#hands;
    const profile = cue.role.profile();
    if (exists) await windows.close(place);
    if (await windows.hasSession(place.session)) {
      await windows.newWindow(place, profile.dir);
    } else {
      await windows.newSession(place, profile.dir);
    }
    const letter = await this.#write(
      cue,
      nowLines(this.#move(cue), cue.role.isBusy()),
    );
    await this.#say(place, launchLine(letter.message(), profile));
    const deadline = this.#hands.clock.now() + WAIT_MS;
    this.#phase = new Launching(deadline, letter.message());
    await this.#phase.step(this, cue);
  }

  async #clear(cue: Cue, place: Place): Promise<void> {
    if (!cue.capacity.take()) return;
    await this.#say(place, "/clear");
    this.#phase = new Clearing(this.#hands.clock.now() + WAIT_MS);
    await this.#phase.step(this, cue);
  }

  async #switchModel(place: Place, model: string): Promise<void> {
    await this.#say(place, `/model ${model}`);
    this.#phase = SWITCHING;
  }

  #watchBusy(cue: Cue): Promise<void> {
    const since = cue.role.busySince();
    const quiet = this.#hands.clock.now() -
      Math.max(since, cue.course.lastAt());
    if (quiet <= HOUR_MS) return Promise.resolve();
    return this.#tell(
      `busy@${since}`,
      `${this.#who()}: занят больше часа без движения`,
    );
  }

  #succeed() {
    this.#phase = RESTING;
    this.#failures = 0;
  }

  async #fail(what: string): Promise<void> {
    this.#failures += 1;
    this.#phase = RESTING;
    if (this.#failures < ATTEMPTS) return;
    this.#phase = HALTED;
    await this.#hands.notices.notify(
      `${this.#who()}: ${what} (${ATTEMPTS} попытки) — ${RESTORE}`,
    );
  }

  /** Уведомление один раз на событие `key`. */
  async #tell(key: string, text: string): Promise<void> {
    if (this.#told.has(key)) return;
    this.#told.add(key);
    await this.#hands.notices.notify(text);
  }

  /** Ход этой роли по журналу снимка. */
  #move(cue: Cue): Move {
    return this.#part.move(cue.course);
  }

  async #write(cue: Cue, now: readonly string[]): Promise<Letter> {
    const letter = new Letter(this.#hands.letterDir, {
      project: this.#project,
      role: this.#part.name,
      profile: cue.role.profile(),
      now,
      ask: this.#part.ask(this.#project),
      decisions: cue.decisions,
    });
    await this.#hands.letters.write(letter.path, letter.text);
    return letter;
  }

  /** Набрать строку и отдельным нажатием — Enter. */
  async #say(place: Place, text: string): Promise<void> {
    const { windows, clock } = this.#hands;
    await windows.type(place, text);
    await clock.sleep(ENTER_PAUSE_MS);
    await windows.enter(place);
  }

  async #screen(place: Place): Promise<Screen> {
    return new Screen(await this.#hands.windows.screen(place));
  }

  #who(): string {
    return `${this.#project} ${this.#part.name}`;
  }
}

/** Запуск: ждём признаков на экране до срока. */
class Launching implements Phase {
  readonly pending = true;
  readonly deadline: number;
  readonly message: string;

  constructor(deadline: number, message: string) {
    this.deadline = deadline;
    this.message = message;
  }

  step(actor: Actor, cue: Cue): Promise<void> {
    return actor.checkLaunch(cue, this);
  }
}

/** Диалог доверия показан: ждём человека, повторов нет. */
class Trusting implements Phase {
  readonly pending = false;
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  step(actor: Actor, cue: Cue): Promise<void> {
    return actor.checkTrust(cue, this.#message);
  }
}

/** После `/clear`: ждём простоя до срока. */
class Clearing implements Phase {
  readonly pending = true;
  readonly #deadline: number;

  constructor(deadline: number) {
    this.#deadline = deadline;
  }

  step(actor: Actor, cue: Cue): Promise<void> {
    return actor.checkCleared(cue, this.#deadline);
  }
}

/** Сообщение дано: ждём отметки `busy` до срока. */
class Waking implements Phase {
  readonly pending = true;
  readonly deadline: number;
  readonly since: number;

  constructor(deadline: number, since: number) {
    this.deadline = deadline;
    this.since = since;
  }

  step(actor: Actor, cue: Cue): Promise<void> {
    return actor.checkWoken(cue, this);
  }
}

/** `/model` набран: следующий шаг сверяет модель. */
const SWITCHING: Phase = {
  pending: false,
  step: (actor, cue) => actor.checkModel(cue),
};

function placeOf(profile: ProfileRecord): Place {
  return { session: profile.session, window: profile.window };
}

/** Признаки удачного запуска: сообщение, модель профиля, режим `auto`. */
function launched(
  screen: Screen,
  message: string,
  profile: ProfileRecord,
): boolean {
  return screen.showsPrompt(message) && screen.shows(profile.model) &&
    (profile.mode !== "auto" || screen.showsAutoMode());
}

/**
 * «Что делать сейчас» при запуске: упавшая роль (занята по отметке, а
 * окна нет) продолжает начатое; ход, если есть, — первым.
 */
function nowLines(move: Move, crashed: boolean): string[] {
  if (!crashed) return [move.line()];
  return move.due ? [move.line(), RESUME_LINE] : [RESUME_LINE];
}

/**
 * Строка запуска для оболочки окна: сообщение — первым аргументом,
 * `--add-dir` вариадический и съел бы строку после себя.
 */
function launchLine(message: string, profile: ProfileRecord): string {
  const words = [
    "claude",
    message,
    "--permission-mode",
    profile.mode,
    "--model",
    profile.model,
    "--name",
    profile.window,
    ...profile.add_dir.flatMap((dir) => ["--add-dir", dir]),
  ];
  return words.map(shellWord).join(" ");
}

/** Слово оболочки: простое — как есть, прочее — в двойных кавычках. */
function shellWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `"${word.replace(/["\\$`]/g, (char) => `\\${char}`)}"`;
}
