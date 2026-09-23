/**
 * Ввод по запросу у сокета строки (`platform/stdin-on-request.md`): клиент
 * ушёл — чтение отвергается, в какой бы момент он ни ушёл.
 */

import { assertRejects } from "@std/assert";
import { InputLost, socketLine } from "./socket.ts";
import { within } from "./testback.ts";

Deno.test("клиент ушёл до первого чтения: чтение отвергается, не висит", async () => {
  const served = Promise.withResolvers<ReturnType<typeof socketLine>>();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (
    request,
  ) => {
    const { socket, response } = Deno.upgradeWebSocket(request);
    served.resolve(socketLine(socket));
    return response;
  });
  try {
    const client = new WebSocket(`ws://127.0.0.1:${server.addr.port}`);
    const opened = Promise.withResolvers<void>();
    client.onopen = () => opened.resolve();
    await opened.promise;
    const { line, input } = await served.promise;
    client.close();
    // Сервер увидел закрытие раньше, чем строка впервые прочла ввод.
    await within(line.gone(), 5_000, "закрытие сокета");
    const requested = input.of({ stdinOnRequest: true });
    await within(
      assertRejects(() => requested.bytes(), InputLost),
      5_000,
      "отказ чтения",
    );
  } finally {
    await server.shutdown();
  }
});
