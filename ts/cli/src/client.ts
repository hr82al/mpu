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
  type ServerFrame,
  serverFrameOf,
  VERSION,
} from "../../back/src/frames/mod.ts";
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
  /** Печать и код клиента. */
  close(env: ClientEnv): number;
  /** Ctrl+C до конца строки. */
  interrupt(): Ending;
}

/** Кадра `exit` не было: сервер оборвал строку. */
const BROKEN: Ending = {
  close(env) {
    env.stderr(mine("сервер оборвал строку"));
    return FAILED;
  },
  interrupt: () => INTERRUPTED,
};

const INTERRUPTED: Ending = {
  close(env) {
    env.stderr(mine("прервано"));
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
  readonly #env: ClientEnv;
  readonly #closed = Promise.withResolvers<void>();
  readonly #clip: Clip;
  readonly #input: ClientInput;
  #ending: Ending = BROKEN;
  #copying: Promise<void> = Promise.resolve();

  constructor(
    door: Door,
    env: ClientEnv,
    clip: Clip,
    input: ClientInput,
    words: readonly string[],
    context: ContextFields,
  ) {
    this.#door = door;
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
    // `Deno.exit`, и незаконченная просьба пропала бы вместе с
    // процессом, не дождавшись программы копирования.
    await this.#copying;
    return this.#ending.close(this.#env);
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
    if ("ask" in frame) {
      // Ответ намеренно не ждётся никем: сервер может закончить строку
      // без него (таймаут 120 с, остановка), и клиент, ждущий строку
      // stdin, повис бы после конца строки. Отвергнуться `#reply` не
      // может — сбой чтения ответа он сам превращает в «нет».
      this.#reply(frame.ask, frame.kind ?? "line");
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
    this.#env.stderr(mine(text));
    this.#ending = exited(code);
    this.#socket.close();
  }

  async #reply(question: string, kind: AskKind) {
    let answer: string;
    try {
      answer = await this.#door.answer(question, kind);
    } catch (err) {
      // Не прочитался ответ — это «нет»: вопрос без ответа сервер так и
      // толкует; причина — в stderr, строку решит сервер.
      const reason = err instanceof Error ? err.message : String(err);
      this.#env.stderr(mine(`ответ не прочитан: ${reason}`));
      answer = "";
    }
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ answer }));
  }
}

/** Отказ до сокета: доступа нет или сервер не отвечает. */
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
    return mine(
      `сервер строк не отвечает на ${env.base} ` +
        `(запуск: systemctl --user start ${ME})`,
    );
  }
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    return mine(`сервер отказал в доступе (${response.status})`);
  }
  return undefined;
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
  const asker: Asker = terminal === undefined
    ? NOBODY
    : humanAsker(env.openTerminal);
  const clip: Clip = terminal === undefined
    ? shown(env.stderr)
    : clipboard(env.copy, env.stderr);
  const door = chooseDoor(await env.mainToken(), await env.agentToken(), asker);
  if (door === undefined) {
    env.stderr(mine(`нет токена доступа (${env.mainTokenPath})`));
    return FAILED;
  }
  // Проверка доступа обычным запросом к той же двери: у сокета отказ
  // соединения и 401/403 различаются только текстом ошибки.
  const refused = await refusal(door, env);
  if (refused !== undefined) {
    env.stderr(refused);
    return FAILED;
  }
  const input = clientInput(env.caller);
  return await new LineSocket(door, env, clip, input, words, context).run();
}
