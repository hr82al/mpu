/**
 * Образ на сервере строк (`platform/image.md`): `define:` и `forget:`
 * переписывают снимок дерева `tree.json`; автор — канал двери.
 */

import { assertEquals } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import { VERSION } from "../version.ts";
import { line, type TestBack, withBack } from "./testback.ts";

const { open: DO, blockEnd: DONE, quote: QUOTE } = GRAMMAR;

/** `ask kiten define: every purpose: ^все^ do version done`. */
const DEFINE = [
  "ask",
  "kiten",
  "define:",
  "every",
  "purpose:",
  `${QUOTE}все${QUOTE}`,
  DO,
  "version",
  DONE,
];

/** Узел метода `kiten every` в снимке на диске; нет — `undefined`. */
async function snapshotNode(back: TestBack): Promise<unknown> {
  const snapshot = JSON.parse(await Deno.readTextFile(back.snapshotFile));
  return snapshot.nodes.find((node: { path: string[] }) =>
    node.path.join(" ") === "kiten every"
  )?.image;
}

Deno.test("define: и forget: переписывают снимок дерева", () =>
  withBack(async (back) => {
    assertEquals(await snapshotNode(back), undefined);
    const defined = await line(back, "/line", DEFINE, ["y"]);
    assertEquals(defined.at(-1), { exit: 0 });
    const node = await snapshotNode(back) as Record<string, unknown>;
    assertEquals([node.author, node.source], ["human", "do version done"]);
    const called = await line(back, "/line", ["kiten", "every"]);
    assertEquals(called.at(-1), { exit: 0 });
    assertEquals(called.filter((frame) => "out" in frame), [
      { out: `${VERSION}\n` },
    ]);
    const forgot = await line(
      back,
      "/line",
      ["ask", "kiten", "forget:", "every"],
      ["y"],
    );
    assertEquals(forgot.at(-1), { exit: 0 });
    assertEquals(await snapshotNode(back), undefined);
  }));

Deno.test("автор метода — канал двери: агент", () =>
  withBack(async (back) => {
    const defined = await line(back, "/agent/line", DEFINE, ["y"]);
    assertEquals(defined.at(-1), { exit: 0 });
    const node = await snapshotNode(back) as Record<string, unknown>;
    assertEquals(node.author, "agent");
  }));
