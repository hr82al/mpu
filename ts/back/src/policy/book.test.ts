/**
 * Файл правил (`platform/policy.md`, «Хранение», «Посев»): посев один раз
 * на путь, запись видна сразу, чужая запись — до следующего решения,
 * нечитаемый файл — отказ, а не `allow`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await body(`${dir}/state/policy.db`);
  } finally {
    await rm(dir, { recursive: true });
  }
}

function decided(book: RuleBook, path: string) {
  return book.decide(path.split(" ")).record();
}

it("посев: пустой файл получает правила, повторный старт не сеет", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, SEEDS);
      expect(book.list()).toStrictEqual([
        { path: "kiten card", verdict: "allow" },
        { path: "kiten comment", verdict: "ask" },
      ]);
      book.set(RulePath.parse("kiten card"), DENY);
    }
    using again = RuleBook.open(file, SEEDS);
    expect(decided(again, "kiten card <args>")).toStrictEqual({
      verdict: "deny",
      won: "kiten card",
    });
  }));

it("посев не возвращает забытое правило", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, SEEDS);
      book.forget(RulePath.parse("kiten card"));
    }
    using again = RuleBook.open(file, SEEDS);
    expect(again.list()).toStrictEqual([{
      path: "kiten comment",
      verdict: "ask",
    }]);
    expect(decided(again, "kiten card <args>")).toStrictEqual({
      verdict: "ask",
      won: null,
    });
  }));

it("посев не заменяет правило, записанное до него", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, []);
      book.set(RulePath.parse("kiten card"), DENY);
    }
    using again = RuleBook.open(file, SEEDS);
    expect(decided(again, "kiten card")).toStrictEqual({
      verdict: "deny",
      won: "kiten card",
    });
  }));

it("своя запись видна следующему решению", () =>
  withDir((file) => {
    using book = RuleBook.open(file, []);
    expect(decided(book, "kiten ls").verdict).toBe("ask");
    book.set(RulePath.parse("kiten ls"), ALLOW);
    expect(decided(book, "kiten ls").verdict).toBe("allow");
    book.forget(RulePath.parse("kiten ls"));
    expect(decided(book, "kiten ls").verdict).toBe("ask");
  }));

it("запись другого процесса видна решению без перезапуска", () =>
  withDir((file) => {
    using a = RuleBook.open(file, [
      new Rule(RulePath.parse("kiten ls"), ALLOW),
    ]);
    expect(decided(a, "kiten ls").verdict).toBe("allow");
    {
      using b = RuleBook.open(file, []);
      b.set(RulePath.parse("kiten ls"), DENY);
    }
    expect(decided(a, "kiten ls")).toStrictEqual({
      verdict: "deny",
      won: "kiten ls",
    });
    expect(a.list()).toStrictEqual([{ path: "kiten ls", verdict: "deny" }]);
  }));

it("файл-мусор — отказ правил, а не allow", () =>
  withDir(async (file) => {
    await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await writeFile(file, "это не SQLite, а мусор ".repeat(100));
    thrown(
      () => RuleBook.open(file, SEEDS),
      PolicyError,
      "правила подтверждения: ",
    );
  }));

it("неизвестное решение в файле — отказ правил", () =>
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
    thrown(
      () => RuleBook.open(file, []),
      PolicyError,
      'правила подтверждения: неизвестное решение "maybe"',
    );
  }));

it("каталога состояния нет — отказ правил", () => {
  thrown(
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

it("миграция: книга без пути — посев allow", () =>
  withDir((file) => {
    expect(hookRule(file)).toBe("allow");
  }));

it("миграция: ask прежней версии — allow один раз; ask человека потом остаётся", () =>
  withDir((file) => {
    oldBook(file, ASK);
    expect(hookRule(file)).toBe("allow");
    expect(hookRule(file)).toBe("allow");
    {
      using book = RuleBook.open(file, HOOK_SEEDS, HOOK_ASK_TO_ALLOW);
      book.set(HOOK, ASK);
    }
    expect(hookRule(file)).toBe("ask");
  }));

it("миграция: свежая книга помечает миграцию — ask человека остаётся", () =>
  withDir((file) => {
    {
      using book = RuleBook.open(file, HOOK_SEEDS, HOOK_ASK_TO_ALLOW);
      book.set(HOOK, ASK);
    }
    expect(hookRule(file)).toBe("ask");
  }));

it("миграция: deny прежней книги не трогается", () =>
  withDir((file) => {
    oldBook(file, DENY);
    expect(hookRule(file)).toBe("deny");
  }));

it("миграция идёт на открытии, sow — без неё", () =>
  withDir((file) => {
    oldBook(file, ASK);
    using book = RuleBook.open(file, []);
    book.sow(HOOK_SEEDS);
    expect(book.list()).toStrictEqual([{ path: HOOK.text(), verdict: "ask" }]);
  }));
