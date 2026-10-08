/**
 * Перевод отказа `@mpu/exec` на границе `ts/`: доменная ошибка с тем же
 * текстом и причиной, прочие ошибки — как есть.
 */

import { ExecError } from "@mpu/exec";
import { rejected } from "@mpu/testing/thrown";
import { expect, it } from "vitest";
import { DomainError } from "../command/mod.ts";
import { runOverPortainer } from "./remote.ts";

/** Цель, до которой дело не дойдёт: граница HTTP подменена. */
const TARGET = {
  access: { baseUrl: "https://p.test", apiKey: "k", verifyTls: true },
  endpointId: 1,
  container: "mp-sl-1-cli",
};

/** Прогон, чей первый HTTP-вызов отвечает `status`, а прочие — 200. */
function runAnswering(status: number) {
  return {
    target: TARGET,
    command: ["true"] as [string],
    stdin: new Uint8Array(),
    output: { out: () => Promise.resolve(), err: () => Promise.resolve() },
    warn: () => {},
    http: () => Promise.resolve({ status, text: "", retryAfter: null }),
  };
}

it("отказ транспорта пакета — доменная ошибка с тем же текстом", async () => {
  const err = await rejected(
    () => runOverPortainer(runAnswering(500)),
    DomainError,
  );
  expect(err.message).toBe("создание exec: Portainer ответил 500");
  expect(err.cause).toBeInstanceOf(ExecError);
});

it("прочая ошибка проходит как есть", async () => {
  const boom = new TypeError("сломалось у вызывающего");
  const run = { ...runAnswering(200), http: () => Promise.reject(boom) };
  const err = await rejected(() => runOverPortainer(run), TypeError);
  expect(err).toBe(boom);
});
