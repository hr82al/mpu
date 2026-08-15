/**
 * Замер для `docs/readability.md`: длина функций и экспорты без JSDoc.
 *
 * Печатает две секции TSV: `LONG` — `путь:строка<TAB>имя<TAB>строк` для функций
 * длиннее порога `ts/CLAUDE.md` (40 строк), `NODOC` — `путь:строка<TAB>имя` для
 * экспортов, над которыми нет блока `/** … *\/`.
 *
 * Длина считается от строки объявления до закрывающей скобки на нулевой глубине —
 * счёт грубый (объектный литерал внутри тела удлиняет результат), поэтому каждый
 * адрес проверяется открытием файла. Запуск: `deno run -A docs/tools/audit_shape.ts`
 * из каталога `ts/`.
 */

const BASE = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SRC = `${BASE}/src`;
const MAX_LINES = 40;

const FUNC =
  /^(export\s+)?(async\s+)?function\s|^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(|^(export\s+)?const\s+\w+\s*=\s*(async\s+)?function/;
const EXPORTED =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Исходники дерева без тестов. */
function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) sources(path, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) {
      acc.push(path);
    }
  }
  return acc;
}

/** Число строк от объявления до закрытия тела по балансу скобок. */
function bodyLength(lines: readonly string[], start: number): number {
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth === 0) return i - start + 1;
  }
  return lines.length - start;
}

const long: string[] = [];
const nodoc: string[] = [];
for (const file of sources(SRC)) {
  const rel = file.replace(`${SRC}/`, "");
  const lines = Deno.readTextFileSync(file).split("\n");
  lines.forEach((line, index) => {
    if (FUNC.test(line)) {
      const len = bodyLength(lines, index);
      const name = /(?:function\s+|const\s+)([A-Za-z_$][\w$]*)/.exec(line)?.[1];
      if (len > MAX_LINES) {
        long.push(`${rel}:${index + 1}\t${name ?? "?"}\t${len}`);
      }
    }
    const exported = EXPORTED.exec(line);
    if (exported && !(lines[index - 1] ?? "").trim().endsWith("*/")) {
      nodoc.push(`${rel}:${index + 1}\t${exported[1]}`);
    }
  });
}
console.log(`LONG\t${long.length}`);
console.log(long.join("\n"));
console.log(`NODOC\t${nodoc.length}`);
console.log(nodoc.join("\n"));
