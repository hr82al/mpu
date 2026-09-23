/**
 * Склейка вызова с записью журнала (`platform/invoke-log.md`): каталог
 * в записи — каталог того, кто позвал, а отказ его чтения не меняет ни
 * результат команды, ни её код.
 */

import { assertEquals } from "@std/assert";
import type { InvokeCommand, InvokeLog } from "../invokelog/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CliEntry, runJournaled } from "./mod.ts";

/** Журнал, который только помнит, о чём его просили. */
function recordingLog(): { log: InvokeLog; begun: InvokeCommand[] } {
  const begun: InvokeCommand[] = [];
  return {
    begun,
    log: {
      begin: (command) => {
        begun.push(command);
        return {
          runId: () => "",
          executedBy: () => {},
          nativeCall: () => {},
          capture: (output) => output,
          out: () => {},
          err: () => {},
          note: () => {},
          finish: () => Promise.resolve(),
        };
      },
    },
  };
}

/** Точка входа теста: печатает строку и отдаёт свой код. */
function printing(text: string): CliEntry {
  return (_args, _io, output) => {
    output.stdout(text);
    return Promise.resolve(7);
  };
}

Deno.test("запись журнала называет каталог того, кто позвал", async () => {
  const { log, begun } = recordingLog();
  const printed: string[] = [];
  const code = await runJournaled(
    ["version"],
    printing("0.0.0\n"),
    makeFakeIo({ cwd: () => "/каталог/вызывающего" }),
    log,
    { stdout: (text) => void printed.push(text), stderr: () => {} },
  );
  assertEquals(code, 7);
  assertEquals(printed.join(""), "0.0.0\n");
  assertEquals(begun, [{
    kind: "argv",
    argv: ["version"],
    cwd: "/каталог/вызывающего",
  }]);
});

Deno.test("каталог исчез: записи нет, вызов доходит до конца", async () => {
  const { log, begun } = recordingLog();
  const printed: string[] = [];
  const code = await runJournaled(
    ["version"],
    printing("0.0.0\n"),
    makeFakeIo({
      cwd: () => {
        throw new Deno.errors.NotFound("каталог удалён");
      },
    }),
    log,
    { stdout: (text) => void printed.push(text), stderr: () => {} },
  );
  // Код и вывод команды не зависят от того, что журнал записать нечего.
  assertEquals(code, 7);
  assertEquals(printed.join(""), "0.0.0\n");
  assertEquals(begun, []);
});
