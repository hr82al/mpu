/**
 * Замер для `docs/readability.md`: экспорты дерева и их потребители.
 *
 * Печатает TSV `путь<TAB>строка<TAB>вид<TAB>имя<TAB>src<TAB>tests<TAB>own`, где
 * `src` — упоминания в исходниках других файлов (включая `main.ts` и `scripts/`),
 * `tests` — в `*_test.ts`, `own` — внутри собственного файла. Строки `import {…}`
 * и `export {…} from` из подсчёта сняты: это проводка, а не использование, иначе
 * реэкспорт-фасад выглядит потребителем.
 *
 * Скан текстовый и намеренно грубый — он даёт список кандидатов, каждый из
 * которых проверяется открытием кода. Запуск: `deno run -A docs/tools/audit_exports.ts`
 * из каталога `ts/`.
 */

const BASE = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SRC = `${BASE}/src`;

/** Объявление экспорта: где стоит и что объявляет. */
interface ExportDecl {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

const DECL =
  /^export\s+(?:declare\s+)?(?:async\s+)?(function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Все `.ts` дерева: исходники, тесты, точка входа и служебные скрипты. */
function collectFiles(): string[] {
  const files = [`${BASE}/main.ts`];
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(SRC);
  walk(`${BASE}/scripts`);
  return files;
}

/** Текст файла без строк-проводки: импортов и реэкспортов. */
function withoutWiring(text: string): string {
  return text
    .replace(
      /^(import|export)\s*(type\s*)?\{[\s\S]*?\}\s*from\s*["'][^"']*["'];?/gm,
      "",
    )
    .replace(/^import\s+[^;\n]*from\s*["'][^"']*["'];?/gm, "")
    .replace(/^export\s*\{[\s\S]*?\};?/gm, "");
}

const files = collectFiles();
const bodies = new Map<string, string>();
const decls: ExportDecl[] = [];
for (const file of files) {
  const text = Deno.readTextFileSync(file);
  bodies.set(file, withoutWiring(text));
  if (file.endsWith("_test.ts") || !file.startsWith(SRC)) continue;
  text.split("\n").forEach((line, index) => {
    const match = DECL.exec(line);
    if (match) {
      decls.push({ name: match[2], file, line: index + 1, kind: match[1] });
    }
  });
}

const rows: string[] = [];
for (const decl of decls) {
  const word = new RegExp(`\\b${decl.name}\\b`, "g");
  let src = 0, tests = 0, own = 0;
  for (const [file, body] of bodies) {
    const hits = (body.match(word) ?? []).length;
    if (hits === 0) continue;
    if (file === decl.file) own += hits - 1; // строка объявления
    else if (file.endsWith("_test.ts")) tests += hits;
    else src += hits;
  }
  rows.push(
    [
      decl.file.replace(`${SRC}/`, ""),
      decl.line,
      decl.kind,
      decl.name,
      src,
      tests,
      own,
    ].join("\t"),
  );
}
console.log(rows.join("\n"));
