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
    const addresses = addressesOf(command, Object.keys(formatsOf(path)));
    for (const input of before.inputs) {
      if (!addresses.has(input.name)) lost.push(`${before.path} ${input.name}`);
    }
  }
  assertEquals(lost, []);
});
