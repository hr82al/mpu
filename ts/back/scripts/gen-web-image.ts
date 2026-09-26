/**
 * Пересборка голденов экранов образа (`web-image.md`, «Golden-примеры»):
 * ответы `tree.snapshot` и `policy.tree` стенда сценария 1 — в testdata
 * `back` и в testdata фронта (`web/src/testdata/snapshot.json`,
 * `policy-tree-image.json`).
 *
 *   deno run --allow-all back/scripts/gen-web-image.ts
 */

import { webImageGoldens } from "../src/backend/testwebimage.ts";

const taken = await webImageGoldens();
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const at = (path: string) => new URL(path, import.meta.url);
await Deno.writeTextFile(
  at("../src/backend/testdata/web/snapshot-image.json"),
  text(taken.snapshot),
);
await Deno.writeTextFile(
  at("../src/backend/testdata/web/policy-tree-image.json"),
  text(taken.policyTree),
);
await Deno.writeTextFile(
  at("../../web/src/testdata/snapshot.json"),
  text(taken.snapshot),
);
await Deno.writeTextFile(
  at("../../web/src/testdata/policy-tree-image.json"),
  text(taken.policyTree),
);
