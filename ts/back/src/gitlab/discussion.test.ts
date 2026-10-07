/**
 * Матчинг дискуссии по селектору (`platform/gitlab-api.md`).
 */

import { describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
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

it("точный id побеждает, регистр не важен", () => {
  expect(matchDiscussion(THREADS, THREADS[0].id.toUpperCase()).id)
    .toStrictEqual(THREADS[0].id);
});

it("однозначный префикс от шести символов", () => {
  expect(matchDiscussion(THREADS, "d7f534").id).toStrictEqual(THREADS[2].id);
});

describe("короткий, ненайденный и неоднозначный префиксы — отказ", () => {
  it("короче шести", () => {
    thrown(
      () => matchDiscussion(THREADS, "d7f53"),
      DiscussionRefError,
      "префикс id дискуссии короче 6 символов: 'd7f53'",
    );
  });

  it("не найден", () => {
    thrown(
      () => matchDiscussion(THREADS, "ffffff"),
      DiscussionRefError,
      "дискуссия 'ffffff' не найдена в этом MR",
    );
  });

  it("неоднозначен — первые 12 символов каждого id", () => {
    thrown(
      () => matchDiscussion(THREADS, "953d39"),
      DiscussionRefError,
      "префикс '953d39' неоднозначен: 953d395bb1c3, 953d395abc2a",
    );
  });
});
