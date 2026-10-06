/**
 * Вопрос-снимок окна tmux (`claude-hook-notification-snapshot.md`,
 * «Вопрос-снимок», «Исходы»): ожидание, которого хуки R1–R3 не отдали,
 * владелец видит блоком диалога с экрана и отвечает кнопками-клавишами,
 * которые нажимаются в окне. Снимок сам решает свой исход: окно сменилось
 * после нажатия, ответили в терминале, окно недоступно.
 */

import {
  ACCEPTED,
  type Asked,
  BOLD_FIRST_LINE,
  type Button,
  type Clock,
  Form,
  KEEP_TAIL,
  OptionKey,
  type Posted,
  preformatted,
  type Rendered,
  type Selection,
  STALE,
  type StepEvents,
  URGENT,
} from "../botquestions/mod.ts";
import { type Dialog, dialogOf } from "./screen.ts";
import type { Pane, ScreenReader } from "./window.ts";

/** Как часто смотреть окно: ответили в терминале — снимок снят. */
export const LOOK_MS = 2000;

/** Через сколько после нажатия снять экран заново. */
export const SETTLE_MS = 1000;

/** Исход: окно закрыто или tmux не отвечает. */
export const WINDOW_GONE = "⌛ окно недоступно";

/** Клавиши ряда под пунктами: подпись — клавиша tmux. */
const KEYS: readonly { readonly label: string; readonly key: string }[] = [
  { label: "⏎", key: "Enter" },
  { label: "⎋", key: "Escape" },
  { label: "↑", key: "Up" },
  { label: "↓", key: "Down" },
];

/** Номера кнопок: пункты — с нуля, клавиши — с `KEY_BASE`, экран — свой. */
const KEY_BASE = 100;
const WHOLE_SCREEN = 200;

/** Что нужно снимку. */
export interface SnapshotParts {
  readonly pane: Pane;
  readonly clock: Clock;
  /** Отдельное сообщение владельцу (`весь экран`). */
  readonly post: (message: Rendered) => Promise<Posted>;
  readonly diagnose: (line: string) => void;
}

/** Слушатель шага до первого нажатия: перерисовывать нечего. */
const NO_EVENTS: StepEvents = { answered: () => {}, changed: () => {} };

/** Работа снимка над окном: исполняется по одной, по очереди. */
type Work = (asked: Asked, stop: AbortSignal) => Promise<void>;

/** Снимок окна сессии. */
export class Snapshot {
  readonly #parts: SnapshotParts;
  #dialog: Dialog;
  #events: StepEvents = NO_EVENTS;
  readonly #queued: Work[] = [];
  /** Разбудить наблюдение: пришла работа. */
  #wake: () => void = () => {};

  /** @param screen экран на момент постановки */
  constructor(parts: SnapshotParts, screen: string) {
    this.#parts = parts;
    this.#dialog = dialogOf(screen);
  }

  /**
   * Форма: голова `🖥` и первое место, остальные места — за ` — `; тело —
   * блок диалога, живой: перечитывается при перерисовке.
   */
  form(places: readonly string[]): Form {
    const [first = "сессия", ...rest] = places;
    const shown = () => this.#dialog.text();
    return new Form({
      places: rest,
      kind: URGENT,
      steps: [{
        head: `🖥 ${first}`,
        get text() {
          return shown();
        },
        options: [],
        choice: { start: () => this.#selection() },
        reply: {
          write: (text, events) => {
            this.#events = events;
            this.#queue((asked, stop) => this.#typed(asked, stop, text));
            return { deliver: () => Promise.resolve() };
          },
        },
        clip: KEEP_TAIL,
        markup: BOLD_FIRST_LINE,
      }],
    });
  }

  /**
   * Наблюдение до исхода `asked` или до `signal`: работа по очереди, без
   * работы — экран каждые `LOOK_MS`.
   */
  async watch(asked: Asked, signal: AbortSignal): Promise<void> {
    const done = new AbortController();
    const stop = AbortSignal.any([signal, done.signal]);
    const ended = asked.outcome.then(() => done.abort());
    while (!stop.aborted) {
      const work = this.#queued.shift();
      if (work !== undefined) {
        await work(asked, stop);
        continue;
      }
      if (await this.#rested(stop)) await this.#looked(asked);
    }
    done.abort();
    await ended;
  }

  /** Кнопки: пункты по одному в ряд, ряд клавиш, `весь экран`. */
  #selection(): Selection {
    return {
      press: (events) => {
        this.#events = events;
        return {
          pick: (index) => this.#picked(index),
          done: () => STALE,
        };
      },
      buttons: () => {
        const items = this.#dialog.items().map((item, index): Button[] => [{
          label: item.label,
          key: new OptionKey(index),
        }]);
        const keys = KEYS.map((one, index): Button => ({
          label: one.label,
          key: new OptionKey(KEY_BASE + index),
        }));
        const screen: Button = {
          label: "весь экран",
          key: new OptionKey(WHOLE_SCREEN),
        };
        return [...items, keys, [screen]];
      },
    };
  }

  /** Работа каждой кнопки нынешнего блока — по номеру кнопки. */
  #works(): ReadonlyMap<number, Work> {
    const press = (key: string): Work => (asked, stop) =>
      this.#pressed(asked, stop, key);
    return new Map<number, Work>([
      ...this.#dialog.items().map((item, index): [number, Work] => [
        index,
        press(String(item.number)),
      ]),
      ...KEYS.map((one, index): [number, Work] => [
        KEY_BASE + index,
        press(one.key),
      ]),
      [WHOLE_SCREEN, (asked) => this.#wholeScreen(asked)],
    ]);
  }

  /**
   * Нажатие кнопки `index`; ответ — подсказка подтверждения. Кнопки, которой
   * у нынешнего блока нет (старое сообщение, прежний блок), — «вопрос уже
   * решён».
   */
  #picked(index: number): string {
    const work = this.#works().get(index);
    if (work === undefined) return STALE;
    this.#queue(work);
    return ACCEPTED;
  }

  #queue(work: Work): void {
    this.#queued.push(work);
    this.#wake();
  }

  /** Пауза до следующего взгляда; ответ — дождалась ли (не разбужена). */
  async #rested(stop: AbortSignal): Promise<boolean> {
    const woken = new AbortController();
    this.#wake = () => woken.abort();
    try {
      await this.#parts.clock.pause(
        LOOK_MS,
        AbortSignal.any([stop, woken.signal]),
      );
      return true;
    } catch (err) {
      // Разбужена работой или наблюдение кончилось — смотреть рано.
      if (!stop.aborted && !woken.signal.aborted) throw err;
      return false;
    }
  }

  /** Экран сменился без нажатия — ответили в терминале. */
  async #looked(asked: Asked): Promise<void> {
    await this.#parts.pane.look({
      seen: (screen) => {
        if (dialogOf(screen).same(this.#dialog)) return;
        asked.withdraw("решено в терминале");
      },
      gone: () => asked.withdrawAs(WINDOW_GONE),
    });
  }

  async #pressed(asked: Asked, stop: AbortSignal, key: string): Promise<void> {
    if (!await this.#parts.pane.press(key)) {
      asked.withdrawAs(WINDOW_GONE);
      return;
    }
    await this.#settled(asked, stop);
  }

  async #typed(asked: Asked, stop: AbortSignal, text: string): Promise<void> {
    if (!await this.#parts.pane.type(text)) {
      asked.withdrawAs(WINDOW_GONE);
      return;
    }
    await this.#settled(asked, stop);
  }

  /**
   * Через `SETTLE_MS` после нажатия — экран заново: диалога больше нет —
   * «окно сменилось»; есть — сообщение правится новым блоком.
   */
  async #settled(asked: Asked, stop: AbortSignal): Promise<void> {
    try {
      await this.#parts.clock.pause(SETTLE_MS, stop);
    } catch (err) {
      if (!stop.aborted) throw err;
      return;
    }
    const reader: ScreenReader<void> = {
      seen: (screen) => {
        const dialog = dialogOf(screen);
        if (!dialog.waiting()) {
          asked.withdrawAs(`✅ окно сменилось — ${dialog.firstLine()}`);
          return;
        }
        this.#dialog = dialog;
        this.#events.changed();
      },
      gone: () => asked.withdrawAs(WINDOW_GONE),
    };
    await this.#parts.pane.look(reader);
  }

  /** `весь экран` — отдельным сообщением, моноширинным, без кнопок. */
  async #wholeScreen(asked: Asked): Promise<void> {
    const screen = await this.#parts.pane.look({
      seen: (screen) => screen,
      gone: () => {
        asked.withdrawAs(WINDOW_GONE);
        return "";
      },
    });
    if (screen === "") return;
    const posted = await this.#parts.post(preformatted(screen.trimEnd()));
    posted.read({
      sent: () => {},
      refused: (reason) =>
        this.#parts.diagnose(`claude-hook notification: весь экран: ${reason}`),
    });
  }
}
