/**
 * Ключи команды эндпоинта (`platform/keys-translation.md`): два входа с
 * одним ключом — дефект объявления, он ловится при сборке команды, а не
 * при вызове.
 */

import { assertThrows } from "@std/assert";
import { endpointCommand } from "./command.ts";
import { EndpointDeclarationError } from "./endpoint.ts";

Deno.test("два входа с одним ключом — отказ объявления", async (t) => {
  const cases = [
    { name: "a", method: "GET", path: "/x/:clientId/y/:client/z/:id" },
    { name: "b", method: "GET", path: "/x/:id/y/:module" },
    {
      name: "c",
      method: "POST",
      path: "/x/:clientId",
      fields: [{ name: "id", type: "string", help: "поле" }],
    },
  ] as const;
  for (const spec of cases) {
    await t.step(spec.path, () => {
      assertThrows(
        () => endpointCommand(spec),
        EndpointDeclarationError,
        "ключ",
      );
    });
  }
});
