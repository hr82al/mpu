/**
 * Файл правил (`platform/policy.md`, «Хранение», «Посев»): посев один раз
 * на путь, запись видна сразу, чужая запись — до следующего решения,
 * нечитаемый файл — отказ, а не `allow`.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  ALLOW,
  ASK,
  DENY,
  PolicyError,
  Rule,
  RuleBook,
  RulePath,
} from "./mod.ts";

const SEEDS: readonly Rule[] = [
  new Rule(RulePath.parse("kiten card"), ALLOW),
  new Rule(RulePath.parse("kiten comment"), ASK),
];

async function withDir(body: (file: string) => void | Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await body(`${dir}/state/policy.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function decided(book: RuleBook, path: string) {
  return book.decide(path.split(" ")).record();
}

Deno.test("посев: пустой файл получает правила, повторный старт не сеет", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, SEEDS);
      assertEquals(book.list(), [
        { path: "kiten card", verdict: "allow" },
        { path: "kiten comment", verdict: "ask" },
      ]);
      book.set(RulePath.parse("kiten card"), DENY);
    }
    using again = RuleBook.open(file, SEEDS);
    assertEquals(decided(again, "kiten card <args>"), {
      verdict: "deny",
      won: "kiten card",
    });
  }));

Deno.test("посев не возвращает забытое правило", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, SEEDS);
      book.forget(RulePath.parse("kiten card"));
    }
    using again = RuleBook.open(file, SEEDS);
    assertEquals(again.list(), [{ path: "kiten comment", verdict: "ask" }]);
    assertEquals(decided(again, "kiten card <args>"), {
      verdict: "ask",
      won: null,
    });
  }));

Deno.test("посев не заменяет правило, записанное до него", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, []);
      book.set(RulePath.parse("kiten card"), DENY);
    }
    using again = RuleBook.open(file, SEEDS);
    assertEquals(decided(again, "kiten card"), {
      verdict: "deny",
      won: "kiten card",
    });
  }));

Deno.test("своя запись видна следующему решению", () =>
  withDir((file) => {
    using book = RuleBook.open(file, []);
    assertEquals(decided(book, "kiten ls").verdict, "ask");
    book.set(RulePath.parse("kiten ls"), ALLOW);
    assertEquals(decided(book, "kiten ls").verdict, "allow");
    book.forget(RulePath.parse("kiten ls"));
    assertEquals(decided(book, "kiten ls").verdict, "ask");
  }));

Deno.test("запись другого процесса видна решению без перезапуска", () =>
  withDir((file) => {
    using a = RuleBook.open(file, [
      new Rule(RulePath.parse("kiten ls"), ALLOW),
    ]);
    assertEquals(decided(a, "kiten ls").verdict, "allow");
    {
      using b = RuleBook.open(file, []);
      b.set(RulePath.parse("kiten ls"), DENY);
    }
    assertEquals(decided(a, "kiten ls"), { verdict: "deny", won: "kiten ls" });
    assertEquals(a.list(), [{ path: "kiten ls", verdict: "deny" }]);
  }));

Deno.test("файл-мусор — отказ правил, а не allow", () =>
  withDir(async (file) => {
    await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(file, "это не SQLite, а мусор ".repeat(100));
    assertThrows(
      () => RuleBook.open(file, SEEDS),
      PolicyError,
      "правила подтверждения: ",
    );
  }));

Deno.test("неизвестное решение в файле — отказ правил", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, []);
      book.set(RulePath.parse("kiten"), ALLOW);
    }
    const raw = new DatabaseSync(file);
    try {
      raw.exec("UPDATE rules SET verdict = 'maybe'");
    } finally {
      raw.close();
    }
    assertThrows(
      () => RuleBook.open(file, []),
      PolicyError,
      'правила подтверждения: неизвестное решение "maybe"',
    );
  }));

Deno.test("каталога состояния нет — отказ правил", () => {
  assertThrows(
    () => RuleBook.open(undefined, SEEDS),
    PolicyError,
    "правила подтверждения: каталог состояния не задан (нет HOME)",
  );
});
