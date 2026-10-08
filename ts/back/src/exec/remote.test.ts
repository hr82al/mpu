/**
 * Перевод отказа `@mpu/exec` на границе `ts/`: доменная ошибка с тем же
 * текстом и причиной, прочие ошибки — как есть.
 */

import { ExecError, type PortainerRun } from "@mpu/exec";
import { rejected } from "@mpu/testing/thrown";
import { expect, it } from "vitest";
import { DomainError } from "@mpu/command";
import { detachOverPortainer, runOverPortainer } from "./remote.ts";

/** Цель, до которой дело не дойдёт: граница HTTP подменена. */
const TARGET = {
  access: { baseUrl: "https://p.test", apiKey: "k", verifyTls: true },
  endpointId: 1,
  container: "mp-sl-1-cli",
};

/** Прогон, чьи HTTP-вызовы отвечают `status`. */
function runAnswering(status: number): PortainerRun {
  return {
    target: TARGET,
    command: ["true"],
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

it("отказ транспорта фонового запуска — доменная ошибка с тем же текстом", async () => {
  const err = await rejected(
    () =>
      detachOverPortainer({
        ...runAnswering(500),
        script: "",
        scriptPath: "/tmp/mpu-run.mjs",
        logPath: "/tmp/mpu-run.log",
      }),
    DomainError,
  );
  expect(err.message).toBe("доставка файла: Portainer ответил 500");
  expect(err.cause).toBeInstanceOf(ExecError);
});
