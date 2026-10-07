/**
 * Пересборка эталона вычислителя `src/line/testdata/evaluator/cases.json`
 * (`docs/specs/platform/evaluator.md`, «Golden-примеры»): у каждого случая
 * строка берётся из эталона, итог — прогоном на стенде. Новый случай —
 * имя и строка с метками, остальное снимет прогон.
 *
 *   bun back/scripts/gen-evaluator-cases.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { allowEverything, withPolicyFile } from "../src/line/testconsent.ts";
import {
  type EvaluatorCase,
  KAITEN_MARK,
  runOnStand,
  unmarked,
  withStand,
} from "../src/line/testprogram.ts";

const FILE = new URL(
  "../src/line/testdata/evaluator/cases.json",
  import.meta.url,
);

const golden = JSON.parse(await readFile(FILE, "utf8")) as {
  cases: Pick<EvaluatorCase, "name" | "line">[];
};
const cases: EvaluatorCase[] = [];
await withPolicyFile((file) =>
  withStand(async (stand) => {
    allowEverything(file);
    for (const { name, line } of golden.cases) {
      const ran = await runOnStand(file, unmarked(line).split(" "), stand);
      const marked = (text: string) =>
        text.replaceAll(stand.baseUrl, KAITEN_MARK);
      cases.push({
        name,
        line,
        stdout: marked(ran.stdout),
        stderr: marked(ran.stderr),
        exit: ran.exit,
      });
    }
  }),
);
await writeFile(FILE, `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`случаев: ${cases.length}`);
