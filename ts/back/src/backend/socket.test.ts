/**
 * Ввод по запросу у сокета строки (`platform/stdin-on-request.md`): клиент
 * ушёл — чтение отвергается, в какой бы момент он ни ушёл.
 */

import { expect, it } from "vitest";
import { listenLoopback, Upgrades } from "./loopback.ts";
import { InputLost, socketLine } from "./socket.ts";
import { within } from "./testback.ts";

it("клиент ушёл до первого чтения: чтение отвергается, не висит", async () => {
  const served = Promise.withResolvers<ReturnType<typeof socketLine>>();
  const upgrades = new Upgrades();
  const server = await listenLoopback({
    port: 0,
    upgrades,
    fetch: (request) =>
      upgrades.accept(request, undefined, (socket) =>
        served.resolve(socketLine(socket)),
      ) ?? new Response(null, { status: 400 }),
  });
  try {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const opened = Promise.withResolvers<void>();
    client.onopen = () => opened.resolve();
    await opened.promise;
    const { line, input } = await served.promise;
    client.close();
    // Сервер увидел закрытие раньше, чем строка впервые прочла ввод.
    await within(line.gone(), 5_000, "закрытие сокета");
    const requested = input.of({ stdinOnRequest: true });
    await within(
      expect(requested.bytes()).rejects.toThrow(InputLost),
      5_000,
      "отказ чтения",
    );
  } finally {
    await server.stop();
  }
});
