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
  Migration,
  PolicyError,
  Rule,
  RuleBook,
  RulePath,
  type Verdict,
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

/** Прежняя версия посеяла хук по признаку `rw`; новая — `allow`. */
const HOOK = RulePath.parse("claude-hook notification");
const HOOK_SEEDS: readonly Rule[] = [new Rule(HOOK, ALLOW)];
const HOOK_ASK_TO_ALLOW: readonly Migration[] = [
  new Migration("R4 claude-hook notification", HOOK, ASK, ALLOW),
];

/** Книга прежней версии: путь хука посеян `verdict`. */
function oldBook(file: string, verdict: Verdict) {
  using _book = RuleBook.open(file, [new Rule(HOOK, verdict)]);
}

function hookRule(file: string): string | null | undefined {
  using book = RuleBook.open(file, HOOK_SEEDS, HOOK_ASK_TO_ALLOW);
  return book.list().find((rule) => rule.path === HOOK.text())?.verdict;
}

Deno.test("миграция: книга без пути — посев allow", () =>
  withDir((file) => {
    assertEquals(hookRule(file), "allow");
  }));

Deno.test("миграция: ask прежней версии — allow один раз; ask человека потом остаётся", () =>
  withDir((file) => {
    oldBook(file, ASK);
    assertEquals(hookRule(file), "allow");
    assertEquals(hookRule(file), "allow");
    {
      using book = RuleBook.open(file, HOOK_SEEDS, HOOK_ASK_TO_ALLOW);
      book.set(HOOK, ASK);
    }
    assertEquals(hookRule(file), "ask");
  }));

Deno.test("миграция: свежая книга помечает миграцию — ask человека остаётся", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, HOOK_SEEDS, HOOK_ASK_TO_ALLOW);
      book.set(HOOK, ASK);
    }
    assertEquals(hookRule(file), "ask");
  }));

Deno.test("миграция: deny прежней книги не трогается", () =>
  withDir((file) => {
    oldBook(file, DENY);
    assertEquals(hookRule(file), "deny");
  }));

Deno.test("миграция идёт на открытии, sow — без неё", () =>
  withDir((file) => {
    oldBook(file, ASK);
    using book = RuleBook.open(file, []);
    book.sow(HOOK_SEEDS);
    assertEquals(book.list(), [{ path: HOOK.text(), verdict: "ask" }]);
  }));
