/**
 * Стенд сценариев O1–O18 (`task-orchestrator.md`, «Сценарии»): поддельный
 * tmux в памяти и поддельная роль-программа вместо `claude`. Программа
 * печатает баннер с моделью и `❯ <сообщение>`, ставит отметки настоящими
 * строками `mpu task busy` на стенде канала и по разделу «Что делать
 * сейчас» читает постановку или отчёт, как читала бы роль. Часы —
 * `FakeTime`: пауза порта двигает их сразу.
 */

import type { FakeTime } from "@std/testing/time";
import { expect, setUp, type Stand } from "../teststand.ts";
import type { Hands, Place, Windows } from "./ports.ts";
import { Orchestra } from "./stage.ts";

/** Как ведёт себя поддельная роль в окне. */
export interface Script {
  /** Не печатает `❯ <сообщение>`. */
  readonly silent?: boolean;
  /** Сообщение получает, но `busy` не ставит. */
  readonly hangs?: boolean;
  /** Показывает эту модель, что бы ни просили. */
  readonly model?: string;
  /** Показывает диалог доверия вместо работы. */
  readonly trust?: boolean;
  /** После `/clear` не освобождается: `esc to interrupt` на экране. */
  readonly stuck?: boolean;
}

/** Нажатие в окне: набранный текст или Enter. */
export type Key = string;
export const ENTER: Key = "⏎";

/** Панель окна: оболочка или поддельная роль. */
class Pane {
  command = "bash";
  lines: string[] = ["$"];
  typed = "";
  model = "";
  readonly keys: Key[] = [];
}

/** Поддельный tmux: сессии, окна, нажатия и роль-программа. */
export class FakeTmux implements Windows {
  readonly sessions = new Set<string>();
  readonly panes = new Map<string, Pane>();
  /** Все нажатия, в том числе в закрытых окнах. */
  readonly history = new Map<string, Key[]>();
  readonly scripts = new Map<string, Script>();
  /** Что делает роль, получив сообщение. */
  onMessage: (place: Place, message: string) => Promise<void> = () =>
    Promise.resolve();

  hasSession(session: string): Promise<boolean> {
    return Promise.resolve(this.sessions.has(session));
  }

  newSession(place: Place, _dir: string): Promise<void> {
    this.sessions.add(place.session);
    return this.newWindow(place, _dir);
  }

  newWindow(place: Place, _dir: string): Promise<void> {
    this.panes.set(nameOf(place), new Pane());
    return Promise.resolve();
  }

  command(place: Place): Promise<string | undefined> {
    return Promise.resolve(this.panes.get(nameOf(place))?.command);
  }

  screen(place: Place): Promise<string> {
    return Promise.resolve(this.#pane(place).lines.join("\n"));
  }

  type(place: Place, text: string): Promise<void> {
    const pane = this.#pane(place);
    pane.typed += text;
    this.#press(place, text);
    return Promise.resolve();
  }

  async enter(place: Place): Promise<void> {
    const pane = this.#pane(place);
    this.#press(place, ENTER);
    const line = pane.typed;
    pane.typed = "";
    if (pane.command !== "claude") return this.#start(place, pane, line);
    await this.#answer(place, pane, line);
  }

  close(place: Place): Promise<void> {
    this.panes.delete(nameOf(place));
    return Promise.resolve();
  }

  /** Окно умерло само (упавшая роль). */
  kill(window: string) {
    this.panes.delete(`w:${window}`);
  }

  /** Нажатия в окне `window` сессии `w` за всё время. */
  keys(window: string, session = "w"): Key[] {
    return this.history.get(`${session}:${window}`) ?? [];
  }

  /** Открыть окно с уже работающей ролью (служба перезапущена). */
  alive(window: string, model = "opus") {
    this.sessions.add("w");
    const pane = new Pane();
    pane.command = "claude";
    pane.model = model;
    pane.lines = banner(model, true);
    this.panes.set(`w:${window}`, pane);
  }

  #pane(place: Place): Pane {
    const pane = this.panes.get(nameOf(place));
    if (pane === undefined) throw new Error(`нет окна ${nameOf(place)}`);
    return pane;
  }

  #press(place: Place, key: Key) {
    const name = nameOf(place);
    const keys = this.history.get(name) ?? [];
    keys.push(key);
    this.history.set(name, keys);
  }

  /** Оболочка получила строку: `claude …` запускает роль. */
  async #start(place: Place, pane: Pane, line: string) {
    const words = shellWords(line);
    if (words[0] !== "claude") return;
    const script = this.scripts.get(place.window) ?? {};
    const flag = (name: string) => words[words.indexOf(name) + 1];
    pane.command = "claude";
    pane.model = script.model ?? flag("--model");
    pane.lines = banner(pane.model, flag("--permission-mode") === "auto");
    if (script.trust) {
      pane.lines.push("Do you trust the files in this folder?");
      return;
    }
    await this.#receive(place, pane, words[1]);
  }

  /** Claude получил строку: команды `/…` или сообщение. */
  async #answer(place: Place, pane: Pane, line: string) {
    const script = this.scripts.get(place.window) ?? {};
    if (line === "/clear") {
      pane.lines = banner(pane.model, true);
      if (script.stuck) pane.lines.push("esc to interrupt");
      return;
    }
    if (line.startsWith("/model ")) {
      pane.model = script.model ?? line.slice("/model ".length);
      pane.lines.push(`model: ${pane.model}`);
      return;
    }
    await this.#receive(place, pane, line);
  }

  async #receive(place: Place, pane: Pane, message: string) {
    const script = this.scripts.get(place.window) ?? {};
    if (!script.silent) pane.lines.push(`❯ ${message}`);
    if (!script.hangs) await this.onMessage(place, message);
  }
}

function nameOf(place: Place): string {
  return `${place.session}:${place.window}`;
}

function banner(model: string, auto: boolean): string[] {
  return [`Claude Code · ${model}`, auto ? "auto mode on" : ""];
}

/** Слова строки оболочки: двойные кавычки и `\` внутри них. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    words.push(match[1]?.replace(/\\(.)/g, "$1") ?? match[2]);
  }
  return words;
}

/** Уведомления и лог, как их видит служба. */
export class FakeNotices {
  readonly notified: string[] = [];
  readonly logged: string[] = [];

  notify(text: string): Promise<void> {
    this.notified.push(text);
    this.logged.push(text);
    return Promise.resolve();
  }

  log(text: string): Promise<void> {
    this.logged.push(text);
    return Promise.resolve();
  }
}

/** Каталог файлов первых сообщений на стенде. */
export const LETTER_DIR = "/run/user/1000/mpu-task";

/** Стенд оркестратора поверх стенда канала. */
export class Rig {
  readonly stand: Stand;
  readonly tmux = new FakeTmux();
  readonly notices = new FakeNotices();
  readonly letters = new Map<string, string>();
  readonly orchestra: Orchestra;
  readonly #time: FakeTime;

  constructor(stand: Stand, time: FakeTime) {
    this.stand = stand;
    this.#time = time;
    const hands: Hands = {
      windows: this.tmux,
      clock: {
        now: () => Date.now(),
        sleep: (ms) => {
          time.tick(ms);
          return Promise.resolve();
        },
      },
      notices: this.notices,
      letters: {
        write: (path, text) => {
          this.letters.set(path, text);
          return Promise.resolve();
        },
      },
      letterDir: LETTER_DIR,
    };
    this.orchestra = new Orchestra(hands, () => stand.openDb());
    this.tmux.onMessage = (place, message) => this.#work(place, message);
  }

  step(): Promise<void> {
    return this.orchestra.step();
  }

  /** Время идёт: `ms` миллисекунд. */
  pass(ms: number) {
    this.#time.tick(ms);
  }

  /**
   * Профиль роли.
   *
   * @param more ключи профиля строки; `powers:` среди них заменяет умолчание
   */
  async profile(role: string, project = "demo", ...more: string[]) {
    const powers = more.includes("powers:")
      ? []
      : ["powers:", "^прод", "—", "только", "чтение^"];
    const run = await this.stand.human(
      "task",
      "role",
      "project:",
      project,
      "role:",
      role,
      "dir:",
      `/tmp/${project}/${role}`,
      ...powers,
      ...more,
    );
    expect(run, 0, "", `изменить профиль роли: ${project} ${role}? [y/N] `);
  }

  /** Отметка роли настоящей строкой канала. */
  async mark(role: string, word: "busy" | "idle", project = "demo") {
    const run = await this.stand.agent(
      "task",
      word,
      "project:",
      project,
      "role:",
      role,
    );
    expect(run, 0, "", "");
  }

  /** Сообщение канала от агента: `post`, `report`, `question`… */
  async say(kind: string, text: string, project = "demo") {
    const run = await this.stand.agent(
      "task",
      kind,
      "project:",
      project,
      "text:",
      text,
    );
    expect(run, 0, "", "");
  }

  /** Текст файла первого сообщения роли. */
  letter(role: string, project = "demo"): string {
    return this.letters.get(`${LETTER_DIR}/${project}/${role}.md`) ?? "";
  }

  /** Роль получила сообщение: `busy`, затем читает, что велено. */
  async #work(_place: Place, message: string) {
    const path = message.match(/^Прочитай файл (\S+) /)?.[1] ?? "";
    const [project, file] = path.split("/").slice(-2);
    const role = file.replace(/\.md$/, "");
    await this.mark(role, "busy", project);
    const letter = this.letters.get(path) ?? "";
    if (letter.includes(`прочитай mpu task read project: ${project}`)) {
      await this.stand.agent("task", "read", "project:", project);
    }
    if (letter.includes("прими порцию")) {
      await this.stand.agent(
        "task",
        "read",
        "project:",
        project,
        "kind:",
        "report",
      );
    }
  }
}

/** Проект `demo` заведён, профили `host` и `exec`. */
export async function demo(rig: Rig, ...execMore: string[]) {
  await setUp(rig.stand);
  await rig.profile("host");
  await rig.profile("exec", "demo", ...execMore);
}
