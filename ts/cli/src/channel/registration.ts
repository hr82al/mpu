/**
 * Регистрация канала в ядре (`claude-channel.md`, «Регистрация в ядре»):
 * соединение `/channel` с ключом сессии, тексты владельца — уведомлениями
 * в stdout, ответ ядру — доставлено или нет. Ядро недоступно или связь
 * оборвалась — повтор через 5 с, пока сессия жива.
 */

import {
  CHANNEL_PATH,
  deliveredFrame,
  failedFrame,
  helloFrame,
  readCoreFrame,
} from "@mpu/language/frames";
import { channelNotification } from "./mcp.ts";

/** Пауза между попытками регистрации. */
export const RETRY_MS = 5000;

/** Что нужно регистрации снаружи. */
export interface RegistrationParts {
  /** Адрес сервера ядра. */
  readonly base: string;
  /** Основной токен; не читается — `undefined`. */
  readonly token: () => Promise<string | undefined>;
  /** Ключ сессии. */
  readonly key: string;
  /** Строка в stdout канала; не записалась — отказ. */
  readonly write: (text: string) => Promise<void>;
  readonly stderr: (text: string) => void;
  /** Пауза; прерывается сигналом. */
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Адрес WebSocket регистрации. */
function channelUrl(base: string): string {
  const url = new URL(CHANNEL_PATH, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return String(url);
}

/** Регистрация канала, пока жив `signal`. */
export class Registration {
  readonly #parts: RegistrationParts;

  constructor(parts: RegistrationParts) {
    this.#parts = parts;
  }

  /**
   * Держит регистрацию до `signal`: соединение, а оборвалось или не
   * открылось — пауза и снова.
   */
  async hold(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const attached = await this.#connection(signal);
      if (signal.aborted) return;
      failures = attached ? 0 : failures + 1;
      // Одна строка на серию отказов: Claude Code stderr не показывает,
      // а повтор каждые 5 с засыпал бы журнал.
      if (failures === 1) {
        this.#parts.stderr(
          `mpu claude-channel: ядро недоступно или нет токена — повтор через ${
            RETRY_MS / 1000
          } с\n`,
        );
      }
      await this.#parts.pause(RETRY_MS, signal).catch(() => {
        // Пауза прервана концом сессии: цикл кончится проверкой сигнала.
      });
    }
  }

  /**
   * Одно соединение до закрытия; ответ — была ли регистрация принята
   * (обрыв принятой — не отказ ядра, а повод переподключиться).
   */
  async #connection(signal: AbortSignal): Promise<boolean> {
    const token = await this.#parts.token();
    // Сессия кончилась, пока читался токен: соединяться незачем.
    if (token === undefined || signal.aborted) return false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(channelUrl(this.#parts.base), [
        "mpu",
        `bearer.${token}`,
      ]);
    } catch (err) {
      // Адрес ядра не разбирается (`MPU_BACK_URL`): это отказ попытки, а
      // не падение канала — сессия работает дальше без текста из чата.
      if (!(err instanceof TypeError || err instanceof DOMException)) {
        throw err;
      }
      return false;
    }
    const closed = Promise.withResolvers<void>();
    /** Доставки этого соединения: их дожидается его конец. */
    const delivering = new Set<Promise<void>>();
    let attached = false;
    const stop = () => socket.close();
    signal.addEventListener("abort", stop, { once: true });
    socket.onopen = () => socket.send(helloFrame(this.#parts.key));
    socket.onmessage = (event) => {
      readCoreFrame(String(event.data), {
        ready: () => {
          attached = true;
          // stderr канала Claude Code пишет в свой журнал MCP: по строке
          // видно, что тексты из чата дойдут.
          this.#parts.stderr("mpu claude-channel: зарегистрирован в ядре\n");
        },
        deliver: (id, text) => {
          const delivery = this.#deliver(socket, id, text).finally(() => {
            delivering.delete(delivery);
          });
          delivering.add(delivery);
        },
        unknown: () => {},
      });
    };
    // Ошибка соединения всегда кончается `close` — там и итог попытки.
    socket.onerror = () => {};
    socket.onclose = () => closed.resolve();
    await closed.promise;
    signal.removeEventListener("abort", stop);
    await Promise.all(delivering);
    return attached;
  }

  /** Текст владельца — в stdout; ядру — доставлено ли. */
  async #deliver(socket: WebSocket, id: number, text: string): Promise<void> {
    let frame = deliveredFrame(id);
    try {
      await this.#parts.write(channelNotification(text));
    } catch (err) {
      // Запись в stdout не удалась: ядру — отказ, вопрос остаётся
      // активным; регистрация не снимается (сценарий R2b-7).
      frame = failedFrame(id);
      this.#parts.stderr(`mpu claude-channel: запись не удалась: ${err}\n`);
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(frame);
  }
}
