/**
 * Образ на сервере строк (`platform/image.md`): `define:` и `forget:`
 * переписывают снимок дерева `tree.json`; автор — канал двери.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { GRAMMAR } from "@mpu/language/messages";
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
  const snapshot = JSON.parse(await readFile(back.snapshotFile, "utf8"));
  return snapshot.nodes.find(
    (node: { path: string[] }) => node.path.join(" ") === "kiten every",
  )?.image;
}

it("define: и forget: переписывают снимок дерева", () =>
  withBack(async (back) => {
    expect(await snapshotNode(back)).toStrictEqual(undefined);
    const defined = await line(back, "/line", DEFINE, ["y"]);
    expect(defined.at(-1)).toStrictEqual({ exit: 0 });
    const node = (await snapshotNode(back)) as Record<string, unknown>;
    expect([node.author, node.source]).toStrictEqual([
      "human",
      "do version done",
    ]);
    const called = await line(back, "/line", ["kiten", "every"]);
    expect(called.at(-1)).toStrictEqual({ exit: 0 });
    expect(called.filter((frame) => "out" in frame)).toStrictEqual([
      { out: `${VERSION}\n` },
    ]);
    const forgot = await line(
      back,
      "/line",
      ["ask", "kiten", "forget:", "every"],
      ["y"],
    );
    expect(forgot.at(-1)).toStrictEqual({ exit: 0 });
    expect(await snapshotNode(back)).toStrictEqual(undefined);
  }));

it("автор метода — канал двери: агент", () =>
  withBack(async (back) => {
    const defined = await line(back, "/agent/line", DEFINE, ["y"]);
    expect(defined.at(-1)).toStrictEqual({ exit: 0 });
    const node = (await snapshotNode(back)) as Record<string, unknown>;
    expect(node.author).toBe("agent");
  }));
