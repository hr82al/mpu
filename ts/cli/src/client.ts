/**
 * Тонкий клиент сервера строк (`docs/specs/cli-client.md`): слова строки —
 * серверу, его кадры — в потоки, вопрос — тому, кто отвечает, код — из
 * кадра `exit`. Сам клиент ничего не исполняет.
 */

import {
  BadFrame,
  type ServerFrame,
  serverFrameOf,
} from "../../back/src/frames/mod.ts";
import { type Asker, humanAsker, NOBODY } from "./asker.ts";
import { chooseDoor, type Door } from "./door.ts";

/** Код прерывания по Ctrl+C: 128 + SIGINT. */
const INTERRUPTED_CODE = 130;

/** Код клиентских отказов. */
const FAILED = 1;

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
  /** И stdin, и stderr — терминалы. */
  readonly terminals: boolean;
  /** Одна строка stdin; конец ввода — `undefined`. */
  readonly readLine: () => Promise<string | undefined>;
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
    env.stderr("mpu-next: сервер оборвал строку\n");
    return FAILED;
  },
  interrupt: () => INTERRUPTED,
};

const INTERRUPTED: Ending = {
  close(env) {
    env.stderr("mpu-next: прервано\n");
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
  #ending: Ending = BROKEN;
  constructor(door: Door, env: ClientEnv, words: readonly string[]) {
    this.#door = door;
    this.#env = env;
    this.#socket = new WebSocket(door.socket(env.base), door.protocols());
    this.#socket.onopen = () =>
      this.#socket.send(JSON.stringify(door.first(words, env.cwd())));
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
    if ("ask" in frame) {
      // Ответ намеренно не ждётся никем: сервер может закончить строку
      // без него (таймаут 120 с, остановка), и клиент, ждущий строку
      // stdin, повис бы после конца строки. Отвергнуться `#reply` не
      // может — сбой чтения ответа он сам превращает в «нет».
      this.#reply(frame.ask);
      return;
    }
    this.#ending = exited(frame.exit);
    this.#socket.close();
  }

  async #reply(question: string) {
    let answer: string;
    try {
      answer = await this.#door.answer(question);
    } catch (err) {
      // Не прочитался ответ — это «нет»: вопрос без ответа сервер так и
      // толкует; причина — в stderr, строку решит сервер.
      const reason = err instanceof Error ? err.message : String(err);
      this.#env.stderr(`mpu-next: ответ не прочитан: ${reason}\n`);
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
    return `mpu-next: сервер строк не отвечает на ${env.base} ` +
      "(запуск: deno task back)\n";
  }
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    return `mpu-next: сервер отказал в доступе (${response.status})\n`;
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
  const asker: Asker = env.terminals
    ? humanAsker(env.stderr, env.readLine)
    : NOBODY;
  const door = chooseDoor(await env.mainToken(), await env.agentToken(), asker);
  if (door === undefined) {
    env.stderr(`mpu-next: нет токена доступа (${env.mainTokenPath})\n`);
    return FAILED;
  }
  // Проверка доступа обычным запросом к той же двери: у сокета отказ
  // соединения и 401/403 различаются только текстом ошибки.
  const refused = await refusal(door, env);
  if (refused !== undefined) {
    env.stderr(refused);
    return FAILED;
  }
  return await new LineSocket(door, env, words).run();
}
