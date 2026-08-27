/**
 * Матчинг дискуссии по селектору (`platform/gitlab-api.md`).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { DiscussionRefError, matchDiscussion } from "./discussion.ts";
import type { Discussion } from "./model.ts";

const thread = (id: string): Discussion => ({
  id,
  resolvable: false,
  resolved: false,
  position: null,
  notes: [],
});

const THREADS = [
  thread("953d395bb1c317b7317d46193627708c31882800"),
  thread("953d395abc2ae6545ba7b0eab6f5378863acbe88"),
  thread("d7f534bcb52ae6545ba7b0eab6f5378863acbe88"),
];

Deno.test("точный id побеждает, регистр не важен", () => {
  assertEquals(
    matchDiscussion(THREADS, THREADS[0].id.toUpperCase()).id,
    THREADS[0].id,
  );
});

Deno.test("однозначный префикс от шести символов", () => {
  assertEquals(matchDiscussion(THREADS, "d7f534").id, THREADS[2].id);
});

Deno.test("короткий, ненайденный и неоднозначный префиксы — отказ", async (t) => {
  await t.step("короче шести", () => {
    assertThrows(
      () => matchDiscussion(THREADS, "d7f53"),
      DiscussionRefError,
      "префикс id дискуссии короче 6 символов: 'd7f53'",
    );
  });

  await t.step("не найден", () => {
    assertThrows(
      () => matchDiscussion(THREADS, "ffffff"),
      DiscussionRefError,
      "дискуссия 'ffffff' не найдена в этом MR",
    );
  });

  await t.step("неоднозначен — первые 12 символов каждого id", () => {
    assertThrows(
      () => matchDiscussion(THREADS, "953d39"),
      DiscussionRefError,
      "префикс '953d39' неоднозначен: 953d395bb1c3, 953d395abc2a",
    );
  });
});
