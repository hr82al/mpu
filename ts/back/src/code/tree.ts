/**
 * Обход дерева репозитория (`platform/code-analyzer.md`).
 *
 * Отдельным модулем, потому что обходов два — состав проекта Deno и
 * файлы текстового анализатора, — а требование к обходу одно: какие
 * каталоги пропускать и какие расширения считать кодом. Пока обходов
 * было два в двух местах, одно изменение требования означало две
 * правки.
 */

/**
 * Каталоги, внутрь которых обход не идёт: зависимости и артефакты
 * сборки. `dist` здесь ради поиска проектов — спека определяет проект
 * как конфигурацию «вне `node_modules` и `dist`».
 */
const SKIPPED_DIRS: readonly string[] = ["node_modules", "dist"];

/**
 * Пропускается ли каталог при обходе состава проекта. Всё, что
 * начинается с точки, — тоже:
 * у проекта вида Deno отсечь кэш иначе нечем, а в `.deno` лежат тысячи
 * `.ts`, и попади они в программу — ответ стал бы неверным молча.
 * Полагаться на то, что репозиторий сам перечислил их в `exclude`,
 * нельзя: это совпадение, а не устройство
 * (`platform/code-analyzer.md`).
 */
function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRS.includes(name);
}

/**
 * Файлы поддерева с одним из расширений; пути — от корня обхода, в
 * лексикографическом порядке. `skip` спрашивается о каждом относительном
 * пути: им отсекается то, что знает не обход, а конфигурация проекта.
 */
export function walkFiles(
  root: string,
  suffixes: readonly string[],
  skip: (relative: string) => boolean = () => false,
  skipDir: (name: string) => boolean = isSkippedDir,
): readonly string[] {
  const found: string[] = [];
  collect(root, "", suffixes, skip, skipDir, found);
  return found.sort();
}

function collect(
  dir: string,
  prefix: string,
  suffixes: readonly string[],
  skip: (relative: string) => boolean,
  skipDir: (name: string) => boolean,
  into: string[],
): void {
  for (const entry of readDirSorted(dir)) {
    const relative = `${prefix}${entry.name}`;
    if (skip(relative)) continue;
    if (entry.isDirectory) {
      if (skipDir(entry.name)) continue;
      collect(
        `${dir}/${entry.name}`,
        `${relative}/`,
        suffixes,
        skip,
        skipDir,
        into,
      );
      continue;
    }
    if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      into.push(relative);
    }
  }
}

/** Записи каталога в стабильном порядке; каталога нет — пусто. */
function readDirSorted(dir: string): readonly Deno.DirEntry[] {
  try {
    return [...Deno.readDirSync(dir)].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}
