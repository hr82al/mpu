/**
 * Дополнение строки (`platform/reflection.md`, «Дополнение»): строка
 * читается тем же разбором, что при исполнении, полные сообщения уходят
 * приёмникам, но конец строки не наступает — команда не исполняется.
 * Кандидатов следующего слова называет отражение того, кто его примет.
 */

import {
  type Evaluation,
  GRAMMAR,
  type KeywordMethod,
  MessageParseError,
  readMessage,
  resolvedMessage,
} from "../messages/mod.ts";
import { spelled } from "./reflection.ts";
import { Refusal, Rejection } from "./refusal.ts";
import { sentOf } from "./sent.ts";
import type { Call, Reflection, Sent, ValueLine, Walker } from "./protocol.ts";

/**
 * Дополнение значений не вычисляет: группа и `stdin` — пустой текст, ни
 * команды, ни чтения.
 */
const UNEVALUATED: Evaluation = {
  group: () => Promise.resolve(""),
  stdin: () => Promise.resolve(""),
};

/** Слово дополнения и что оно значит. */
export interface Suggestion {
  readonly word: string;
  readonly purpose: string;
}

/**
 * Посыльный строки дополнения: сообщения уходят приёмникам, `help` не
 * меняет пути, конец строки не наступает никогда.
 */
class Probe implements Walker {
  #pending: Call;

  constructor(origin: Call) {
    this.#pending = origin;
  }

  help() {}

  async send(sent: Sent) {
    const receiver = await this.#pending.perform();
    this.#pending = receiver.lookup(sent);
  }

  /** Кто примет следующее сообщение: его разбор и его отражение. */
  next() {
    const kind = this.#pending.result();
    return { parsing: kind.parsing(), reflection: kind.reflect() };
  }
}

/**
 * Ключи, которые ещё можно добавить к набранному ключевому сообщению:
 * у методов, содержащих набранные ключи, — не набранные и списки.
 */
function moreKeys(
  methods: readonly KeywordMethod[],
  typed: readonly string[],
): Suggestion[] {
  const fitting = methods.filter((method) =>
    typed.every((key) => key in method.keys)
  );
  return fitting.flatMap((method) =>
    Object.entries(method.keys)
      .filter(([name, kind]) => !typed.includes(name) || kind === "list")
      .map(([name, kind]) => ({
        word: spelled(name, kind),
        purpose: method.purposes?.[name] ?? "",
      }))
  );
}

/** Сообщения приёмника: унарные словом, ключевые — первым ключом. */
function messagesOf(reflection: Reflection): Suggestion[] {
  return reflection.messages().map((line) => ({
    word: line.selector,
    purpose: line.purpose,
  }));
}

function asSuggestions(values: readonly ValueLine[]): Suggestion[] {
  return values.map((line) => ({ word: line.value, purpose: line.purpose }));
}

/** Ключ, ждущий значения: последнее набранное слово `ключ:`. */
function pendingKey(words: readonly string[]): string | undefined {
  const last = words.at(-1);
  if (last === undefined || !last.endsWith(":") || last.length < 2) {
    return undefined;
  }
  return last.slice(0, -1);
}

/**
 * Проходит набранное и отдаёт кандидатов: либо ключи незаконченного
 * ключевого сообщения, либо то, что понимает следующий приёмник.
 */
async function walked(
  probe: Probe,
  typed: readonly string[],
  key: string | undefined,
  prefix: string,
): Promise<Suggestion[]> {
  let rest = typed[0] === GRAMMAR.open ? typed.slice(1) : typed;
  while (rest.length > 0) {
    const step = readMessage(rest, probe.next().parsing);
    // Последнее ключевое сообщение не посылается: к нему ещё допишут.
    if (step.rest.length === 0 && "keyword" in step.message) {
      const next = probe.next();
      if (key !== undefined) {
        return asSuggestions(await next.reflection.candidates(key, prefix));
      }
      return moreKeys(next.parsing.keyword, Object.keys(step.message.keyword));
    }
    rest = step.rest;
    await sentOf(await resolvedMessage(step.message, UNEVALUATED)).enter(probe);
  }
  const next = probe.next();
  if (key !== undefined) {
    return asSuggestions(await next.reflection.candidates(key, prefix));
  }
  return messagesOf(next.reflection);
}

/** Строка дополнения словами: последнее слово — дописываемое. */
export function typedWords(line: string): { typed: string[]; word: string } {
  const words = line.split(" ").filter((word, i, all) =>
    word !== "" || i === all.length - 1
  );
  return { typed: words.slice(0, -1), word: words.at(-1) ?? "" };
}

/**
 * Кандидаты следующего слова строки `line` на дереве с корнем `origin`.
 * Строка, которую разбор не принимает, — кандидатов нет.
 *
 * @param line набранное после `mpu`; последнее слово — дописываемое
 * @param origin корень дерева
 */
export async function completeLine(
  line: string,
  origin: Call,
): Promise<Suggestion[]> {
  const { typed, word } = typedWords(line);
  if (typed.at(-1) === GRAMMAR.literal) return [];
  const key = pendingKey(typed);
  const before = key === undefined ? typed : typed.slice(0, -1);
  try {
    const found = await walked(new Probe(origin), before, key, word);
    // Значения ключа уже отобраны по набранному (у клиента — и по имени);
    // слова протокола — по началу.
    const chosen = key === undefined
      ? found.filter((one) => one.word.startsWith(word))
      : found;
    return unique(chosen);
  } catch (err) {
    // Незаконченная или неверная строка — не отказ дополнения, а пустой
    // ответ: человек ещё пишет её.
    if (err instanceof MessageParseError || err instanceof Refusal) return [];
    if (err instanceof Rejection) return [];
    throw err;
  }
}

/** Первое вхождение каждого слова: одинаковые ключи у двух методов. */
function unique(found: readonly Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return found.filter((one) => {
    if (seen.has(one.word)) return false;
    seen.add(one.word);
    return true;
  });
}
