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
import { TERMINAL } from "./decision.ts";
import { type Dialog, dialogOf } from "./screen.ts";
import type { KeysReader, Pane, PaneGuard, ScreenReader } from "./window.ts";

/** Как часто смотреть окно: ответили в терминале — снимок снят. */
export const LOOK_MS = 2000;

/** Через сколько после нажатия снять экран заново. */
export const SETTLE_MS = 1000;

/** Исход: окно закрыто или tmux не отвечает. */
export const WINDOW_GONE = "⌛ окно недоступно";

/** Исход: в окне уже не Claude Code («Охрана окна»). */
export const CLAUDE_LEFT = "✅ окно сменилось — Claude Code закрыт";

/** Ответ владельцу на текст, когда в окне уже не Claude Code. */
export const NOTHING_SENT = "окно уже не Claude Code — ничего не отправлено";

/** Клавиши ряда под пунктами: подпись — клавиша tmux. */
const KEYS: readonly { readonly label: string; readonly key: string }[] = [
  { label: "⏎", key: "Enter" },
  { label: "⎋", key: "Escape" },
  { label: "↑", key: "Up" },
  { label: "↓", key: "Down" },
];

/**
 * Номер кнопки — поколение блока и место: пункты — места 0–8, клавиши — с
 * `KEY_SLOT`, экран — `SCREEN_SLOT`. Поколение растёт с каждым новым
 * блоком: кнопка прежнего блока (сообщение ещё не поправлено) не нажмёт
 * пункт нового, которого владелец не видел.
 */
const SLOTS = 20;
const KEY_SLOT = 10;
const SCREEN_SLOT = 15;
/** Поколений — сколько влезает в три цифры номера кнопки. */
const GENERATIONS = 49;

/** Что нужно снимку. */
export interface SnapshotParts {
  readonly pane: Pane;
  readonly clock: Clock;
  /** Отдельное сообщение владельцу (`весь экран`). */
  readonly post: (message: Rendered) => Promise<Posted>;
  readonly diagnose: (line: string) => void;
}

/** Слушатель шага до первого нажатия: перерисовывать нечего. */
const NO_EVENTS: StepEvents = {
  answered: () => {},
  closed: () => {},
  changed: () => {},
};

/** Работа снимка над окном: исполняется по одной, по очереди. */
type Work = (asked: Asked, stop: AbortSignal) => Promise<void>;

/** Работа в очереди и блок, по которому её заказали. */
interface Queued {
  readonly generation: number;
  readonly work: Work;
}

/** Снимок окна сессии. */
export class Snapshot {
  readonly #parts: SnapshotParts;
  #dialog: Dialog;
  /** Поколение нынешнего блока. */
  #generation = 0;
  #events: StepEvents = NO_EVENTS;
  readonly #queued: Queued[] = [];
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
      steps: [
        {
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
        },
      ],
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
      const next = this.#queued.shift();
      if (next !== undefined) {
        // Заказана по прежнему блоку (второе касание, пока шёл снимок) —
        // в новый блок вслепую не жмётся.
        if (next.generation === this.#generation) await next.work(asked, stop);
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
        const items = this.#dialog.items().map((item, index): Button[] => [
          {
            label: item.label,
            key: new OptionKey(this.#numbered(index)),
          },
        ]);
        const keys = KEYS.map(
          (one, index): Button => ({
            label: one.label,
            key: new OptionKey(this.#numbered(KEY_SLOT + index)),
          }),
        );
        const screen: Button = {
          label: "весь экран",
          key: new OptionKey(this.#numbered(SCREEN_SLOT)),
        };
        return [...items, keys, [screen]];
      },
    };
  }

  /** Номер кнопки места `slot` нынешнего блока. */
  #numbered(slot: number): number {
    return (this.#generation % GENERATIONS) * SLOTS + slot;
  }

  /** Работа каждой кнопки нынешнего блока — по номеру кнопки. */
  #works(): ReadonlyMap<number, Work> {
    const press =
      (key: string): Work =>
      (asked, stop) =>
        this.#pressed(asked, stop, key);
    return new Map<number, Work>([
      ...this.#dialog
        .items()
        .map((item, index): [number, Work] => [
          this.#numbered(index),
          press(String(item.number)),
        ]),
      ...KEYS.map((one, index): [number, Work] => [
        this.#numbered(KEY_SLOT + index),
        press(one.key),
      ]),
      [this.#numbered(SCREEN_SLOT), (asked) => this.#wholeScreen(asked)],
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
    this.#queued.push({ generation: this.#generation, work });
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
        asked.withdraw(TERMINAL);
      },
      ...this.#ended(asked),
    });
  }

  /** Окно недоступно или в нём уже не Claude Code — исход снимка. */
  #ended(asked: Asked): PaneGuard<void> {
    return {
      gone: () => asked.withdrawAs(WINDOW_GONE),
      left: () => asked.withdrawAs(CLAUDE_LEFT),
    };
  }

  async #pressed(asked: Asked, stop: AbortSignal, key: string): Promise<void> {
    // Исход пришёл, пока работа ждала очереди: окно уже не то.
    if (stop.aborted) return;
    const next = await this.#parts.pane.press(
      key,
      this.#afterKeys(asked, stop, () => Promise.resolve()),
    );
    await next();
  }

  async #typed(asked: Asked, stop: AbortSignal, text: string): Promise<void> {
    if (stop.aborted) return;
    const next = await this.#parts.pane.type(
      text,
      this.#afterKeys(asked, stop, () =>
        this.#post({ text: NOTHING_SENT, entities: [] }, "ответ"),
      ),
    );
    await next();
  }

  /**
   * После клавиш: ушли — экран заново; окно недоступно или в нём уже не
   * Claude Code — исход, а владельцу ещё и `answer`.
   */
  #afterKeys(
    asked: Asked,
    stop: AbortSignal,
    answer: () => Promise<void>,
  ): KeysReader<() => Promise<void>> {
    const ended = this.#ended(asked);
    return {
      sent: () => () => this.#settled(asked, stop),
      gone: () => () => Promise.resolve(ended.gone()),
      left: () => () => {
        ended.left();
        return answer();
      },
    };
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
        if (!dialog.same(this.#dialog)) this.#generation += 1;
        this.#dialog = dialog;
        this.#events.changed();
      },
      ...this.#ended(asked),
    };
    await this.#parts.pane.look(reader);
  }

  /** `весь экран` — отдельным сообщением, моноширинным, без кнопок. */
  async #wholeScreen(asked: Asked): Promise<void> {
    const ended = this.#ended(asked);
    const post = await this.#parts.pane.look<() => Promise<void>>({
      seen: (screen) => () => this.#postScreen(screen.trimEnd()),
      gone: () => () => Promise.resolve(ended.gone()),
      left: () => () => Promise.resolve(ended.left()),
    });
    await post();
  }

  /** Экран целиком; пустой — сообщения нет (Telegram пустое отвергает). */
  async #postScreen(screen: string): Promise<void> {
    if (screen === "") return;
    await this.#post(preformatted(screen), "весь экран");
  }

  /** Отдельное сообщение владельцу; отказ — в журнал службы под `what`. */
  async #post(message: Rendered, what: string): Promise<void> {
    const posted = await this.#parts.post(message);
    posted.read({
      sent: () => {},
      refused: (reason) =>
        this.#parts.diagnose(`claude-hook notification: ${what}: ${reason}`),
    });
  }
}
