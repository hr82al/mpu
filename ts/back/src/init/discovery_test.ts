/**
 * Тесты чистой классификации контейнеров (`docs/specs/init.md`, шаг 2):
 * отображаемое имя и номер sl-сервера из docker-имён контейнера.
 * Табличная форма — по одному случаю на правило разбора.
 */

import { assertEquals } from "@std/assert";
import { classifyContainer } from "./discovery.ts";

interface Case {
  readonly name: string;
  readonly names: readonly string[];
  readonly containerName: string;
  readonly serverNumber: number | null;
}

const CASES: readonly Case[] = [
  {
    name: "sl-N-cli с ведущим /",
    names: ["/sl-3-cli"],
    containerName: "sl-3-cli",
    serverNumber: 3,
  },
  {
    name: "sl-N-cli без ведущего /",
    names: ["sl-7-cli"],
    containerName: "sl-7-cli",
    serverNumber: 7,
  },
  {
    name: "mp-sl-N-cli (префикс mp-)",
    names: ["/mp-sl-12-cli"],
    containerName: "mp-sl-12-cli",
    serverNumber: 12,
  },
  {
    name: "sl-0-cli — номер 0 включён",
    names: ["/sl-0-cli"],
    containerName: "sl-0-cli",
    serverNumber: 0,
  },
  {
    name: "номер — из второго имени, если не совпадает первое",
    names: ["/some-alias", "/sl-5-cli"],
    containerName: "some-alias",
    serverNumber: 5,
  },
  {
    name: "прочий контейнер — serverNumber null",
    names: ["/wb-loader-1"],
    containerName: "wb-loader-1",
    serverNumber: null,
  },
  {
    name: "похожее имя без -cli — не матчится",
    names: ["/sl-3-clix"],
    containerName: "sl-3-clix",
    serverNumber: null,
  },
];

Deno.test("classifyContainer: имя и номер сервера из docker-имён", async (t) => {
  for (const testCase of CASES) {
    await t.step(testCase.name, () => {
      assertEquals(classifyContainer(testCase.names), {
        containerName: testCase.containerName,
        serverNumber: testCase.serverNumber,
      });
    });
  }
});
