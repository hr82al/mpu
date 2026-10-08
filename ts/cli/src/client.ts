/**
 * Тонкий клиент сервера строк (`docs/specs/cli-client.md`): слова строки —
 * серверу, его кадры — в потоки, вопрос — тому, кто отвечает, код — из
 * кадра `exit`. Сам клиент ничего не исполняет.
 */

import {
  type AskKind,
  BadFrame,
  type CallerFacts,
  type ContextFields,
  contextFieldsOf,
  HOOK_LINES,
  type HookWords,
  type ServerFrame,
  serverFrameOf,
} from "@mpu/language/frames";
import { VERSION } from "../../back/src/version.ts";
import type { TerminalIo } from "./terminal/mod.ts";
import { type Asker, humanAsker, NOBODY } from "./asker.ts";
import { type Clip, clipboard, shown } from "./clip.ts";
import { chooseDoor, type Door } from "./door.ts";
import { type ClientInput, clientInput } from "./input.ts";

/**
 * Имя, которым человек зовёт систему: им названы и программа, и её
 * служба (`platform/cutover.md`). Названо здесь один раз — все семь
 * диагностик клиента складываются из него.
 */
const ME = "mpu";

/** Строка диагностики клиента: имя, двоеточие, текст, перевод строки. */
function mine(text: string): string {
  return `${ME}: ${text}\n`;
}

/** Код прерывания по Ctrl+C: 128 + SIGINT. */
const INTERRUPTED_CODE = 130;

/** Код клиентских отказов. */
const FAILED = 1;

/** Код отказа по входу: строка не исполняется — ввод больше предела. */
const REFUSED_INPUT = 2;

/** Что клиенту дано снаружи. */
export interface ClientEnv {
  /** Адрес сервера (`MPU_BACK_URL` или `http://127.0.0.1:7338`). */
  readonly base: string;
  /** Путь основного токена — для текста «нет токена». */
  readonly mainTokenPath: string;
  /** Основной токен; не читается — `undefined`. */
  readonly mainToken: () => Promise<string | undefined>;
  /** Агентский токен; не читается — `undefined`. */
  readonly agentToken: () => Promise<string | undefined>;
  /** Что клиент снимает у себя: ввод, терминальность, переменные. */
  readonly caller: CallerFacts;
  /**
   * Как клиент называет себя в кадре (`caller`, `platform/it.md`): по
   * этому имени `back` помнит его прошлый результат.
   */
  readonly name: string;
  /** Открыть управляющий терминал; его нет — спросить некого. */
  readonly openTerminal: () => Promise<TerminalIo | undefined>;
  /** Положить текст в буфер обмена; удалось ли. */
  readonly copy: (text: string) => Promise<boolean>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: () => string;
  /** Завершается по Ctrl+C. */
  readonly interrupted: Promise<void>;
}

/** Чем кончилась строка, пока сокет не закрыт. */
interface Ending {
  /** Диагностика исходу строки и код клиента. */
  close(fate: LineFate): number;
  /** Ctrl+C до конца строки. */
  interrupt(): Ending;
}

/** Кадра `exit` не было: сервер оборвал строку. */
const BROKEN: Ending = {
  close(fate) {
    fate.complain("сервер оборвал строку");
    return FAILED;
  },
  interrupt: () => INTERRUPTED,
};

const INTERRUPTED: Ending = {
  close(fate) {
    fate.complain("прервано");
    return INTERRUPTED_CODE;
  },
  interrupt: () => INTERRUPTED,
};

/** Кадр `exit` пришёл: код строки, прерывание его не меняет. */
function exited(code: number): Ending {
  const ending: Ending = { close: () => code, interrupt: () => ending };
  return ending;
}

/** Строка по сокету: что делают кадры. */
class LineSocket {
  readonly #socket: WebSocket;
  readonly #door: Door;
  readonly #fate: LineFate;
  readonly #env: ClientEnv;
  readonly #closed = Promise.withResolvers<void>();
  readonly #clip: Clip;
  readonly #input: ClientInput;
  #ending: Ending = BROKEN;
  #copying: Promise<void> = Promise.resolve();
  /** Снятие идущего вопроса: решён в другом месте (кадр `settled`). */
  #asked = new AbortController();

  constructor(
    door: Door,
    fate: LineFate,
    clip: Clip,
    input: ClientInput,
    words: readonly string[],
    context: ContextFields,
  ) {
    const env = fate.env;
    this.#door = door;
    this.#fate = fate;
    this.#env = env;
    this.#clip = clip;
    this.#input = input;
    this.#socket = new WebSocket(door.socket(env.base), door.protocols());
    this.#socket.onopen = () =>
      this.#socket.send(
        JSON.stringify(door.first(words, env.cwd(), context, env.name)),
      );
    this.#socket.onmessage = (event) => this.#received(event.data);
    this.#socket.onerror = () => {
      // Причину скажет закрытие: без кадра `exit` строка оборвана.
    };
    this.#socket.onclose = () => this.#closed.resolve();
  }

  /** Код строки, когда сокет закрыт. */
  async run(): Promise<number> {
    await Promise.race([
      this.#closed.promise,
      this.#env.interrupted.then(() => this.#interrupt()),
    ]);
    await this.#closed.promise;
    // Копирование переживает закрытие сокета: клиент выходит
    // `process.exit`, и незаконченная просьба пропала бы вместе с
    // процессом, не дождавшись программы копирования.
    await this.#copying;
    return this.#ending.close(this.#fate);
  }

  /** Ctrl+C: сокет закрывается, сервер отвечает на вопрос «нет». */
  #interrupt() {
    this.#ending = this.#ending.interrupt();
    this.#socket.close();
  }

  #received(data: unknown) {
    let frame: ServerFrame;
    try {
      frame = serverFrameOf(data);
    } catch (err) {
      // Кадр не из контракта: пропускается, строку решит `exit` или
      // закрытие.
      if (!(err instanceof BadFrame)) throw err;
      return;
    }
    this.#act(frame);
  }

  /** Действие кадра (граница контракта: вид кадра — его ключ). */
  #act(frame: ServerFrame) {
    if ("out" in frame) return this.#env.stdout(frame.out);
    if ("err" in frame) return this.#env.stderr(frame.err);
    // Отказ-объект — для агента; человек читает тот же текст кадром `err`
    // (`platform/refusal-object.md`).
    if ("refusal" in frame) return;
    // Картинка — блок изображения агенту; печать человеку прежняя,
    // побайтово (`platform/picture-frame.md` [D.4]).
    if ("picture" in frame) return;
    if ("ask" in frame) {
      // Ответ намеренно не ждётся никем: сервер может закончить строку
      // без него (таймаут 120 с, остановка), и клиент, ждущий строку
      // stdin, повис бы после конца строки. Отвергнуться `#reply` не
      // может — сбой чтения ответа он сам превращает в «нет».
      this.#asked = new AbortController();
      this.#reply(frame.ask, frame.kind ?? "line", this.#asked.signal);
      return;
    }
    // Вопрос решён владельцем в Telegram: ввод больше не ждётся, ответ
    // не уходит, строка идёт дальше своими кадрами
    // (`platform/ask-telegram.md` [D.2]).
    if ("settled" in frame) {
      this.#asked.abort();
      this.#fate.complain(frame.settled);
      return;
    }
    // Просьба положить текст в буфер обмена: куда он ляжет — в буфер
    // или в stderr — решает сам клиент (`platform/line-prompt.md`).
    if ("clip" in frame) {
      // Копирования идут по одному и в порядке прихода: буфер один, и
      // две просьбы разом положили бы в него неизвестно что.
      this.#copying = this.#copying.then(() => this.#clip.put(frame.clip));
      return;
    }
    if ("stdinRequest" in frame) {
      // Как и ответ на вопрос, ввод не ждётся никем: строку решит
      // `exit` или закрытие. Отвергнуться `#supply` не может — сбой
      // чтения он сам превращает в конец строки.
      this.#supply();
      return;
    }
    this.#ending = exited(frame.exit);
    this.#socket.close();
  }

  /**
   * Ввод строке по её запросу. Больше предела — прежний отказ клиента,
   * код 2; не прочитался — причина в stderr, код 1. В обоих случаях сокет
   * закрывается: сервер видит обрыв как отмену строки.
   */
  async #supply() {
    let text: string;
    try {
      text = await this.#input.supply();
    } catch (err) {
      if (err instanceof BadFrame) {
        this.#end(err.report, REFUSED_INPUT);
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.#end(`ввод не прочитан: ${reason}`, FAILED);
      return;
    }
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ stdin: text }));
  }

  /** Конец строки со стороны клиента: причина, код, закрыть сокет. */
  #end(text: string, code: number) {
    this.#fate.complain(text);
    this.#ending = exited(code);
    this.#socket.close();
  }

  /** @param signal вопрос снят: ответа не отправлять */
  async #reply(question: string, kind: AskKind, signal: AbortSignal) {
    let answer: string;
    try {
      answer = await this.#door.answer(question, kind, signal);
    } catch (err) {
      // Не прочитался ответ — это «нет»: вопрос без ответа сервер так и
      // толкует; причина — в stderr, строку решит сервер.
      const reason = err instanceof Error ? err.message : String(err);
      this.#fate.complain(`ответ не прочитан: ${reason}`);
      answer = "";
    }
    if (signal.aborted) return;
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ answer }));
  }
}

/** Отказ до сокета, причина без имени: доступа нет или сервер не отвечает. */
async function refusal(
  door: Door,
  env: ClientEnv,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(door.http(env.base), { headers: door.headers() });
  } catch (err) {
    // `fetch` отвергает сетевой сбой именно `TypeError`: соединения нет.
    if (!(err instanceof TypeError)) throw err;
    // Подсказка ведёт к службе, а не к дереву исходников: у человека,
    // у которого сломалась установка, дерева под рукой может не быть
    // (`platform/cutover.md`).
    return (
      `сервер строк не отвечает на ${env.base} ` +
      `(запуск: systemctl --user start ${ME})`
    );
  }
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    return `сервер отказал в доступе (${response.status})`;
  }
  return undefined;
}

/**
 * Исход строки: какие потоки она получает, куда идёт диагностика
 * клиента и какой у клиента код.
 */
interface LineFate {
  /** Окружение, которое получает строка. */
  readonly env: ClientEnv;
  /** Диагностика клиента: причина — без имени `mpu: `. */
  complain(cause: string): void;
  /** Код клиента по коду строки; печать отложенного — здесь. */
  closed(code: number): number;
}

/** Обычная строка: потоки как пришли, код — её. */
class PlainFate implements LineFate {
  readonly env: ClientEnv;

  constructor(env: ClientEnv) {
    this.env = env;
  }

  complain(cause: string) {
    this.env.stderr(mine(cause));
  }

  closed(code: number): number {
    return code;
  }
}

/**
 * Строка-хук (`claude-hook-pre-tool-use.md`, «Клиент»): код всегда 0 —
 * иначе Claude Code блокировал бы вызов. Вывод держится до кода: 0 —
 * stdout и stderr печатаются как есть, иначе вместо них одна строка «без
 * решения» хука с первой причиной — текстом клиента или первой строкой
 * кадров `err` ядра.
 */
class HookFate implements LineFate {
  readonly env: ClientEnv;
  readonly #outer: ClientEnv;
  readonly #hook: HookWords;
  #heldOut = "";
  #heldErr = "";
  #cause: string | undefined;

  constructor(env: ClientEnv, hook: HookWords) {
    this.#outer = env;
    this.#hook = hook;
    this.env = {
      ...env,
      stdout: (text) => void (this.#heldOut += text),
      stderr: (text) => this.#heard(text, text.split("\n")[0]),
    };
  }

  complain(cause: string) {
    this.#heard(mine(cause), cause);
  }

  closed(code: number): number {
    if (code === 0) {
      if (this.#heldOut !== "") this.#outer.stdout(this.#heldOut);
      if (this.#heldErr !== "") this.#outer.stderr(this.#heldErr);
      return 0;
    }
    const hook = this.#hook;
    this.#outer.stderr(hook.undecided(hook.unavailable(this.#cause ?? "")));
    return 0;
  }

  /** Печать удержана; причина исхода — первая услышанная. */
  #heard(text: string, cause: string) {
    this.#heldErr += text;
    this.#cause ??= cause;
  }
}

/** Исход по словам: хук — ровно его слова, без справки и прочего. */
function fateOf(words: readonly string[], env: ClientEnv): LineFate {
  const hook = HOOK_LINES.find((line) => line.is(words));
  return hook === undefined ? new PlainFate(env) : new HookFate(env, hook);
}

/**
 * Исполняет строку на сервере и возвращает код клиента.
 *
 * @param words слова строки как есть
 * @param env окружение клиента
 */
export async function runClient(
  words: readonly string[],
  env: ClientEnv,
): Promise<number> {
  const fate = fateOf(words, env);
  return fate.closed(await lineCode(words, fate));
}

/** Строка на сервере: код строки или клиентского отказа. */
async function lineCode(
  words: readonly string[],
  fate: LineFate,
): Promise<number> {
  const env = fate.env;
  if (words.length === 1 && words[0] === "--version") {
    env.stdout(`${VERSION}\n`);
    return 0;
  }
  // stdin здесь не читается: ввод строка попросит сама, когда он ей
  // понадобится (`platform/stdin-on-request.md`).
  const context = contextFieldsOf(env.caller);
  // Спросить есть кого, когда открывается управляющий терминал: у
  // клиента в середине конвейера stdin занят данными, и по нему он
  // объявил бы «спросить некого» (`cli-client.md`, «Канал и токен»).
  using terminal = await env.openTerminal();
  // Тем же терминалом решается и судьба кадра `clip`: буфер обмена
  // есть у того, у кого есть терминал (`platform/line-prompt.md`).
  const asker: Asker =
    terminal === undefined ? NOBODY : humanAsker(env.openTerminal);
  const clip: Clip =
    terminal === undefined
      ? shown(env.stderr)
      : clipboard(env.copy, env.stderr);
  const door = chooseDoor(await env.mainToken(), await env.agentToken(), asker);
  if (door === undefined) {
    fate.complain(`нет токена доступа (${env.mainTokenPath})`);
    return FAILED;
  }
  // Проверка доступа обычным запросом к той же двери: у сокета отказ
  // соединения и 401/403 различаются только текстом ошибки.
  const refused = await refusal(door, env);
  if (refused !== undefined) {
    fate.complain(refused);
    return FAILED;
  }
  const input = clientInput(env.caller, words);
  return await new LineSocket(door, fate, clip, input, words, context).run();
}
