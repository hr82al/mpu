/**
 * Все случаи эталона `cases.json` (`docs/specs/platform/messages.md`).
 * Разбор идёт шагами: каждому шагу отдаётся описание только его
 * приёмника — `receivers[i]` для шага `i`, как это сделает исполнитель
 * цепочки, узнающий следующий приёмник лишь после сообщения.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import golden from "./testdata/messages/cases.json" with { type: "json" };
import {
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
}

function kindOf(text: string | undefined): KeyKind {
  if (text === "value" || text === "flag") return text;
  throw new Error(`в эталоне неизвестный вид ключа: ${text}`);
}

function described(raw: RawReceiver): ReceiverDescription {
  return {
    unary: raw.unary,
    tail: raw.tail,
    keyword: raw.keyword.map((method) => ({
      keys: Object.fromEntries(
        Object.entries(method.keys).map(([key, kind]) => [key, kindOf(kind)]),
      ),
      required: method.required,
    })),
  };
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

Deno.test("в эталоне 39 случаев", () => {
  assertEquals(golden.cases.length, 39);
});

Deno.test("случаи эталона разбора сообщений", async (t) => {
  for (const c of golden.cases) {
    await t.step(c.name, () => {
      if ("error" in c) {
        const err = assertThrows(
          () => readChain(c.words, c.receivers),
          MessageParseError,
        );
        assertEquals(err.message, c.error);
        return;
      }
      const expected: unknown = c.messages;
      assertEquals<unknown>(readChain(c.words, c.receivers), expected);
    });
  }
});
