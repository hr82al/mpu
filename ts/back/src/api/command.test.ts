/**
 * Ключи команды эндпоинта (`platform/keys-translation.md`): два входа с
 * одним ключом — дефект объявления, он ловится при сборке команды, а не
 * при вызове.
 */

import { describe, expect, it } from "vitest";
import { endpointCommand } from "./command.ts";
import { EndpointDeclarationError } from "./endpoint.ts";

describe("два входа с одним ключом — отказ объявления", () => {
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
    it(spec.path, () => {
      expect(() => endpointCommand(spec)).toThrow(EndpointDeclarationError);
      expect(() => endpointCommand(spec)).toThrow("ключ");
    });
  }
});
