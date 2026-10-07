import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { hasErrorCode, isPermissionRefusal, osError } from "./mod.ts";

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

it("отказ права узнаётся по имени, а не по коду", () => {
  const refused = new Error("Requires write access");
  refused.name = "NotCapable";
  expect(isPermissionRefusal(refused)).toBe(true);
  expect(isPermissionRefusal(osError("EACCES", "нет права"))).toBe(false);
});
