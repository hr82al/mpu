/**
 * Варианты от `mpu-back` (`platform/reflection.md`, «mpu-complete»):
 * строка `complete: <набранное> end json` по `/line` с основным токеном.
 * Отказ, чужой ответ, не нулевой код — вариантов от `back` нет, решает
 * снимок. Клиент минимальный: один POST и чтение кадров контрактом.
 */

import { BadFrame, serverFrameOf } from "../../back/src/frames/mod.ts";
import type { Choice } from "./tree.ts";

/** Что клиенту нужно снаружи: адрес, токен, сеть и срок ответа. */
export interface BackWay {
  /** Адрес сервера (`MPU_BACK_URL` или `http://127.0.0.1:7338`). */
  readonly base: string;
  /** Основной токен; нет — `back` не спрашивается. */
  readonly token: string | undefined;
  readonly fetch: typeof fetch;
  /** Сигнал срока ответа: истёк — решает снимок. */
  readonly deadline: () => AbortSignal;
}

/** Ответ `complete:` как данные: `[{word, purpose}]`. */
function choicesOf(text: string): Choice[] | undefined {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) return undefined;
  return data.flatMap((item) =>
    typeof item?.word === "string" && typeof item?.purpose === "string"
      ? [{ value: item.word, summary: item.purpose }]
      : []
  );
}

/** Кадры ответа: вывод целиком и код; вопрос или чужой кадр — нет ответа. */
function outputOf(body: string): string | undefined {
  let out = "";
  for (const row of body.split("\n")) {
    if (row === "") continue;
    const frame = serverFrameOf(row);
    if ("out" in frame) out += frame.out;
    else if ("exit" in frame) return frame.exit === 0 ? out : undefined;
    else if ("ask" in frame) return undefined;
  }
  return undefined;
}

/**
 * Варианты строки от `back`; `back` не спросить или он не ответил как
 * надо — `undefined`, и тогда варианты даёт снимок.
 *
 * @param line набранное после `mpu`; последнее слово — дописываемое
 * @param way адрес, токен, сеть и срок
 */
export async function askBack(
  line: string,
  way: BackWay,
): Promise<readonly Choice[] | undefined> {
  if (way.token === undefined) return undefined;
  try {
    const response = await way.fetch(`${way.base}/line`, {
      method: "POST",
      headers: { Authorization: `Bearer ${way.token}` },
      body: JSON.stringify({
        words: ["complete:", line, "end", "json"],
        cwd: "/",
        human: false,
      }),
      signal: way.deadline(),
    });
    const body = await response.text();
    if (!response.ok) return undefined;
    const out = outputOf(body);
    return out === undefined ? undefined : choicesOf(out);
  } catch (err) {
    // Не запущен, не успел, ответил не по контракту — варианты даёт
    // снимок: дополнение не падает (`specs/complete.md`). Прочее — дефект.
    if (err instanceof TypeError || err instanceof SyntaxError) {
      return undefined;
    }
    if (err instanceof DOMException || err instanceof BadFrame) {
      return undefined;
    }
    throw err;
  }
}
