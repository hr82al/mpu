/**
 * Пересборка голденов `ask` в составной строке
 * `src/line/testdata/ask-door/composite-*.json`
 * (`docs/specs/platform/ask-composite.md`, «Golden-примеры»): вход случая
 * (описание, строка, ответы, обстоятельства) берётся из файла, итог —
 * прогоном на стенде. Новый случай — файл со входом, остальное снимет
 * прогон.
 *
 *   bun back/scripts/gen-composite-cases.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import {
  COMPOSITE_DIR,
  compositeFiles,
  type CompositeInput,
  runComposite,
} from "../src/line/testcomposite.ts";

const names = await compositeFiles();
for (const name of names) {
  const url = new URL(name, COMPOSITE_DIR);
  const kept = JSON.parse(await readFile(url, "utf8")) as CompositeInput;
  const taken = await runComposite({
    описание: kept.описание,
    строка: kept.строка,
    ответы: kept.ответы,
    "без человека": kept["без человека"],
    "правило посреди строки": kept["правило посреди строки"],
  });
  await writeFile(url, `${JSON.stringify(taken, null, 2)}\n`);
}
console.log(`случаев: ${names.length}`);
