/**
 * Ввод у сервера (`platform/stdin-on-request.md`): строка со словами ввод
 * не запрашивает, пока он ей не нужен.
 */

import { expect, it } from "vitest";
import { line, withBack } from "./testback.ts";

it("сокет /line со словами: ввода не просит", () =>
  withBack(async (back) => {
    const frames = await line(back, "/line", ["version"]);
    expect(frames.some((frame) => "stdinRequest" in frame)).toBe(false);
  }));
