/**
 * Полнота перевода на ключи (`platform/keys-translation.md`, «Проверка
 * полноты и пара»): у каждого входа снимка старой схемы есть адрес в новой
 * записи — ключ, формат результата или снятое написание. Вход без адреса
 * — потерянная возможность.
 */

import { assertEquals } from "@std/assert";
import snapshot from "../registry/testdata/inputs-before-159.json" with {
  type: "json",
};
import { findCommand } from "../registry/mod.ts";
import { addressesOf } from "./keyed.ts";
import { formatsOf } from "./tree.ts";

Deno.test("у каждого входа снимка есть адрес в новой записи", () => {
  const lost: string[] = [];
  for (const before of snapshot) {
    const path = before.path.split(" ");
    const command = findCommand(path);
    if (command === undefined) {
      lost.push(`${before.path}: команды нет`);
      continue;
    }
    // Без объявления ключей лист остаётся хвостом прежней строки.
    if (command.keys === undefined) {
      lost.push(`${before.path}: ключи не объявлены`);
      continue;
    }
    const addresses = addressesOf(command, Object.keys(formatsOf(path)));
    for (const input of before.inputs) {
      if (!addresses.has(input.name)) lost.push(`${before.path} ${input.name}`);
    }
  }
  assertEquals(lost, []);
});

/** Форматы, которые прежде выбирал булев флаг (`--json`): адрес — формат. */
function isFormat(address: string): boolean {
  return address.startsWith("формат ");
}

Deno.test("каждый флаг поведения снимка — вариант, выбор --via — варианты", () => {
  const lost: string[] = [];
  for (const before of snapshot) {
    const path = before.path.split(" ");
    const command = findCommand(path);
    if (command === undefined) continue;
    const addresses = addressesOf(command, Object.keys(formatsOf(path)));
    for (const input of before.inputs) {
      const address = addresses.get(input.name) ?? "";
      // Булев вход без умолчания передаёт значение в три состояния
      // (`is-active`) — он ключ, а не вариант (`platform/variants.md`).
      const behaviour = input.kind === "boolean" && "default" in input;
      const choice = input.name === "via";
      if (!behaviour && !choice) continue;
      if (isFormat(address)) continue;
      const expected = choice ? "варианты " : "вариант ";
      if (!address.startsWith(expected)) {
        lost.push(`${before.path} ${input.name}: ${address}`);
      }
    }
  }
  assertEquals(lost, []);
});
