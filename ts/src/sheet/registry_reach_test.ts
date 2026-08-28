/**
 * Достижимость экспортов `src/sheet/registry.ts`.
 *
 * Модуль заводился под две работы — алиасы и наполнение реестра
 * таблиц, — и вторую у него забрали (`docs/specs/sheet-registry.md`,
 * `sync` исключён). Осиротевший экспорт после такого не виден ничем:
 * он компилируется, проходит lint и не мешает тестам — его просто
 * никто не зовёт. Проверка и стережёт этот случай: у каждого экспорта
 * обязан быть хоть один читатель за пределами самого файла.
 */

import { assertEquals } from "@std/assert";

/** Имена, объявленные модулем наружу. */
function exportedNames(source: string): readonly string[] {
  const names: string[] = [];
  const pattern =
    /^export (?:async function|function|const|class|interface|type) (\w+)/gm;
  for (const match of source.matchAll(pattern)) names.push(match[1]);
  return names;
}

/** Все `.ts` под `src`, кроме одного исключённого файла. */
async function sources(root: URL, except: string): Promise<readonly string[]> {
  const texts: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(
        `${entry.name}${entry.isDirectory ? "/" : ""}`,
        dir,
      );
      if (entry.isDirectory) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (child.pathname.endsWith(except)) continue;
      texts.push(await Deno.readTextFile(child));
    }
  };
  await walk(root);
  return texts;
}

Deno.test("у каждого экспорта реестра есть читатель", async () => {
  const module = new URL("./registry.ts", import.meta.url);
  const declared = exportedNames(await Deno.readTextFile(module));
  // Модуль не пуст: пустой список экспортов прошёл бы проверку молча,
  // и она перестала бы что-либо значить.
  assertEquals(declared.length > 0, true);
  const texts = await sources(
    new URL("../", import.meta.url),
    "sheet/registry.ts",
  );
  const orphans = declared.filter((name) =>
    !texts.some((text) => new RegExp(`\\b${name}\\b`).test(text))
  );
  assertEquals(orphans, [], `экспорт без читателей: ${orphans.join(", ")}`);
});
