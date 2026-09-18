/**
 * Кадры строки (`platform/back-rpc.md`, «Строка») — данные границы:
 * разбор входящих здесь, дальше — объекты строки и канала.
 */

/** Первый кадр клиента: какую строку, где и есть ли кого спросить. */
export interface LineRequest {
  readonly words: readonly string[];
  /** Абсолютный каталог клиента. */
  readonly cwd: string;
  /** Есть ли у клиента, кого спросить; не сказано — нет. */
  readonly human: boolean;
}

/** Первый кадр не разобрался. */
export class BadFrame extends Error {
  override name = "BadFrame";
}

/** Кадр сервера. */
export type ServerFrame =
  | { readonly out: string }
  | { readonly err: string }
  | { readonly ask: string; readonly ticket?: string }
  | { readonly exit: number };

function parsed(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    // Причина разбора клиенту не нужна: ответ один на все её виды.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Первый кадр строки.
 *
 * @param data данные кадра как их отдал сокет
 * @throws BadFrame — не JSON-объект, нет `words` или `cwd`, `cwd` не
 *   абсолютный, `human` не булево
 */
export function lineRequest(data: unknown): LineRequest {
  const frame = parsed(data);
  if (!isRecord(frame)) throw new BadFrame("кадр не объект JSON");
  const { words, cwd, human = false } = frame;
  if (
    !Array.isArray(words) || !words.every((word) => typeof word === "string")
  ) {
    throw new BadFrame("words — не список строк");
  }
  if (typeof cwd !== "string" || !cwd.startsWith("/")) {
    throw new BadFrame("cwd — не абсолютный путь");
  }
  if (typeof human !== "boolean") throw new BadFrame("human — не булево");
  return { words: [...words], cwd, human };
}

/** Ответ на вопрос из кадра клиента; кадр не ответ — `undefined`. */
export function answerOf(data: unknown): string | undefined {
  const frame = parsed(data);
  if (!isRecord(frame) || typeof frame.answer !== "string") return undefined;
  return frame.answer;
}

/**
 * Кадр сервера глазами клиента (`fixtures/back-rpc/schema.json`,
 * `line.server`).
 *
 * @param data данные кадра как их отдал сокет
 * @throws BadFrame — не объект JSON или не один из четырёх видов
 */
export function serverFrameOf(data: unknown): ServerFrame {
  const frame = parsed(data);
  if (!isRecord(frame)) throw new BadFrame("кадр сервера не объект JSON");
  const keys = Object.keys(frame);
  if (keys.length !== 1) throw new BadFrame("у кадра сервера не одно поле");
  const [key] = keys;
  const value = frame[key];
  if (key === "exit" && typeof value === "number" && Number.isInteger(value)) {
    return { exit: value };
  }
  if (typeof value !== "string") throw new BadFrame(`кадр ${key} не строка`);
  if (key === "out") return { out: value };
  if (key === "err") return { err: value };
  if (key === "ask") return { ask: value };
  throw new BadFrame(`неизвестный кадр ${key}`);
}

/**
 * Тело ответа на вопрос строки простым HTTP (`platform/back-http-line.md`):
 * номер и ответ. Не разобралось — пустой номер (такого нет — 404), ответа
 * нет — пустой ответ («нет»).
 */
export function ticketAnswerOf(
  data: unknown,
): { readonly ticket: string; readonly answer: string } {
  const body = parsed(data);
  if (!isRecord(body)) return { ticket: "", answer: "" };
  const { ticket, answer } = body;
  return {
    ticket: typeof ticket === "string" ? ticket : "",
    answer: typeof answer === "string" ? answer : "",
  };
}
