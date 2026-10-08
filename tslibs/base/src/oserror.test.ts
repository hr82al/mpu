import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { hasErrorCode, osError } from "./oserror.ts";

it("код настоящей ошибки файловой системы различается", async () => {
  const err = await readFile("/нет-такого-пути").catch((err) => err);
  expect(hasErrorCode(err, "ENOENT")).toBe(true);
  expect(hasErrorCode(err, "EACCES", "ENOENT")).toBe(true);
  expect(hasErrorCode(err, "EACCES")).toBe(false);
});

it("не ошибка и ошибка без кода — не ошибка ОС", () => {
  expect(hasErrorCode({ code: "ENOENT" }, "ENOENT")).toBe(false);
  expect(hasErrorCode(new Error("ENOENT"), "ENOENT")).toBe(false);
});

it("подменная ошибка несёт код", () => {
  expect(hasErrorCode(osError("EPIPE", "труба"), "EPIPE")).toBe(true);
});
