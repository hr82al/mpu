/**
 * Все случаи эталона `cases.json` (`docs/specs/platform/messages.md`).
 * Разбор идёт шагами: каждому шагу отдаётся описание только его
 * приёмника — `receivers[i]` для шага `i`, как это сделает исполнитель
 * цепочки, узнающий следующий приёмник лишь после сообщения.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import golden from "./testdata/messages/cases.json" with { type: "json" };
import {
  GRAMMAR,
  type KeyKind,
  type Message,
  MessageParseError,
  readMessage,
  type ReceiverDescription,
} from "./mod.ts";

interface RawReceiver {
  readonly unary: readonly string[];
  readonly keyword: readonly {
    // Импорт JSON дополняет члены объединения ключами `?: undefined`.
    readonly keys: Readonly<Record<string, string | undefined>>;
    readonly required: readonly string[];
  }[];
  readonly tail?: string;
  readonly foreign?: boolean;
}

function kindOf(text: string | undefined): KeyKind {
  if (text === "value" || text === "flag") return text;
  throw new Error(`в эталоне неизвестный вид ключа: ${text}`);
}

function described(raw: RawReceiver): ReceiverDescription {
  return {
    unary: raw.unary,
    tail: raw.tail,
    ...(raw.foreign === true ? { foreign: true } : {}),
    keyword: raw.keyword.map((method) => ({
      keys: Object.fromEntries(
        Object.entries(method.keys).map(([key, kind]) => [key, kindOf(kind)]),
      ),
      required: method.required,
    })),
  };
}

/**
 * Слова грамматики в эталоне — метками: эталон не зависит от того, как
 * они пишутся (`platform/line-grammar.md` [D.1]).
 */
const MARKS: Readonly<Record<string, string>> = {
  $open: GRAMMAR.open,
  $close: GRAMMAR.close,
  $literal: GRAMMAR.literal,
};

function word(text: string): string {
  return MARKS[text] ?? text;
}

/** Эталон со словами грамматики вместо меток. */
function unmarked(value: unknown): unknown {
  if (typeof value === "string") return value.split(" ").map(word).join(" ");
  if (Array.isArray(value)) return value.map(unmarked);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, unmarked(item)]),
  );
}

const receivers = new Map<string, ReceiverDescription>(
  Object.entries(golden.receivers).map((
    [name, raw],
  ) => [name, described(raw)]),
);

function receiverFor(
  names: readonly string[],
  step: number,
): ReceiverDescription {
  if (step >= names.length) {
    throw new Error(`в эталоне нет приёмника для шага ${step}`);
  }
  const receiver = receivers.get(names[step]);
  if (receiver === undefined) {
    throw new Error(`в эталоне нет описания приёмника ${names[step]}`);
  }
  return receiver;
}

/** Разбирает строку шаг за шагом, пока не кончатся слова. */
function readChain(
  words: readonly string[],
  names: readonly string[],
): Message[] {
  const messages: Message[] = [];
  let rest = words;
  do {
    const step = readMessage(rest, receiverFor(names, messages.length));
    assert(
      rest.length === 0 || step.rest.length < rest.length,
      `шаг ${messages.length} не забрал ни одного слова`,
    );
    messages.push(step.message);
    rest = step.rest;
  } while (rest.length > 0);
  return messages;
}

Deno.test("в эталоне 58 случаев", () => {
  assertEquals(golden.cases.length, 58);
});

Deno.test("случаи эталона разбора сообщений", async (t) => {
  for (const c of golden.cases) {
    await t.step(c.name, () => {
      const words = c.words.map(word);
      if ("error" in c) {
        const err = assertThrows(
          () => readChain(words, c.receivers),
          MessageParseError,
        );
        assertEquals(err.message, unmarked(c.error));
        return;
      }
      assertEquals<unknown>(
        readChain(words, c.receivers),
        unmarked(c.messages),
      );
    });
  }
});
