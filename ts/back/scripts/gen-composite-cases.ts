/**
 * Пересборка голденов `ask` в составной строке
 * `src/line/testdata/ask-door/composite-*.json`
 * (`docs/specs/platform/ask-composite.md`, «Golden-примеры»): вход случая
 * (описание, строка, ответы, обстоятельства) берётся из файла, итог —
 * прогоном на стенде. Новый случай — файл со входом, остальное снимет
 * прогон.
 *
 *   deno run --allow-all back/scripts/gen-composite-cases.ts
 */

import {
  COMPOSITE_DIR,
  compositeFiles,
  type CompositeInput,
  runComposite,
} from "../src/line/testcomposite.ts";

const names = await compositeFiles();
for (const name of names) {
  const url = new URL(name, COMPOSITE_DIR);
  const kept = JSON.parse(await Deno.readTextFile(url)) as CompositeInput;
  const taken = await runComposite({
    описание: kept.описание,
    строка: kept.строка,
    ответы: kept.ответы,
    "без человека": kept["без человека"],
    "правило посреди строки": kept["правило посреди строки"],
  });
  await Deno.writeTextFile(url, `${JSON.stringify(taken, null, 2)}\n`);
}
console.log(`случаев: ${names.length}`);
