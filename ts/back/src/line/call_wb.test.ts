/**
 * Сценарий W14 (`docs/specs/call.md`, «Доводка 173d») на уровне строки:
 * объявления `wb call-ro` / `wb call` через строку берут свой токен —
 * `call-ro` предпочитает `read_only`, `call` (через дверь `ask`) —
 * пишущий. Сообщения — `wbMessages` пакета `@mpu/cmd-call` над его стендом
 * (`@mpu/cmd-call/testing`: те же токены и ответ WB, что у сценариев `wb`
 * пакета); прочие сценарии `wb` — в пакете. Тест здесь, потому что ему
 * нужна строка приложения.
 */

import { describe, expect, it } from "vitest";
import { wbMessages } from "@mpu/cmd-call";
import {
  ENV,
  envFileOf,
  wbReply,
  wbSessions,
  withCache,
} from "@mpu/cmd-call/testing";
import { makeFakeIo } from "@mpu/command/testing";
import type { InvokeJournal, Invoker } from "../entrypoint/mod.ts";
import { lineEntry } from "./mod.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";

const W1_URL =
  "https://statistics-api.wildberries.ru/api/v5/supplier/" +
  "reportDetailByPeriod?dateFrom=2026-09-01";

const W1_STDOUT =
  "HTTP 200 GET statistics-api.wildberries.ru/api/v5/" +
  "supplier/reportDetailByPeriod?dateFrom=2026-09-01\n" +
  "x-ratelimit-remaining: 9\nx-ratelimit-limit: 10\n\n[]\n";

/**
 * Строка на стенде: разбор, дверь и правила настоящие; объявления
 * `wb call-ro` / `wb call` — те же `wbMessages`, что в дереве, над
 * заглушками стенда.
 */
async function lineOnStand(words: readonly string[], answers?: string[]) {
  const requests: Request[] = [];
  let stdout = "";
  let stderr = "";
  let code = -1;
  const stand = wbMessages({
    fetch: (request) => {
      requests.push(request);
      return Promise.resolve(wbReply());
    },
    deadline: () => new AbortController().signal,
    now: () => 0,
    openSession: wbSessions([]),
  });
  const invoker: Invoker = {
    invoke: (command, args, io) => {
      const path = command.path.join(" ");
      const same = stand.find((one) => one.path.join(" ") === path);
      return (same ?? command).invoke(args, io);
    },
  };
  const human =
    answers === undefined
      ? {}
      : { stdinIsTerminal: () => true, stderrIsTerminal: () => true };
  const journal = {
    nativeCall: () => {},
    note: () => {},
  } as unknown as InvokeJournal;
  await withPolicyFile((file) =>
    withCache(async (open) => {
      const io = makeFakeIo({
        envFile: envFileOf(ENV),
        openCacheDb: open,
        readStdin: () => Promise.resolve(new Uint8Array()),
        ...human,
      });
      const ports = { ...consentOf(file, answers), invoker };
      code = await lineEntry(ports)(
        words,
        io,
        {
          stdout: (text: string) => void (stdout += text),
          stderr: (text: string) => void (stderr += text),
        },
        journal,
      );
    }),
  );
  return { code, stdout, stderr, requests };
}

describe("W14: объявления через строку — call-ro берёт w-ro, call — w-rw", () => {
  const keys = ["target:", "57", "url:", W1_URL];
  it("W1: wb call-ro", async () => {
    const ran = await lineOnStand(["wb", "call-ro", ...keys]);
    expect([ran.code, ran.stdout]).toStrictEqual([0, W1_STDOUT]);
    expect(ran.requests.length).toBe(1);
    expect(ran.requests[0].headers.get("authorization")).toBe("w-ro");
  });
  it("W2: ask wb call, ответ y", async () => {
    const ran = await lineOnStand(["ask", "wb", "call", ...keys], ["y"]);
    expect([ran.code, ran.stdout]).toStrictEqual([0, W1_STDOUT]);
    expect(ran.requests.length).toBe(1);
    expect(ran.requests[0].headers.get("authorization")).toBe("w-rw");
  });
});
