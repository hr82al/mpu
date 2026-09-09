/**
 * Как собирается бинарь `mpu`: аргументы `deno compile` берутся из
 * задачи `build` в `deno.jsonc` и больше ниоткуда.
 *
 * Второй копии этого разбора быть не должно. Список `--allow-*` —
 * договор о правах программы, и разъехавшиеся копии не покажет ни
 * компилятор, ни тест: бинарь просто окажется собран с правами,
 * которых модуль не объявлял, и отказ увидит пользователь.
 */

/** Задачи `build` в `deno.jsonc` нет либо она не той формы. */
export class BuildTaskError extends Error {
  override name = "BuildTaskError";
}

/**
 * Чем раскрываются переменные строки задачи и куда кладётся результат.
 * Каталоги — параметры, а не окружение процесса: собирающий строит
 * бинарь и себе (`$HOME` пользователя), и подставному прогону
 * (`scripts/smoke.ts`), и путать эти два случая нельзя.
 */
export interface CompileTarget {
  /** Значение `$HOME` в правах собираемого бинаря. */
  readonly home: string;
  /** Значение `$XDG_CONFIG_HOME` там же. */
  readonly configHome: string;
  /** Путь готового бинаря: подменяет значение `-o` задачи. */
  readonly out: string;
}

/**
 * Аргументы `deno` для сборки бинаря по задаче `build`. Подменяются
 * только путь вывода и два каталога окружения; список прав переносится
 * дословно.
 *
 * `deno task` подставляет незаданную переменную пустой строкой, поэтому
 * умолчание `$XDG_CONFIG_HOME` — забота вызывающего: пустое значение
 * превратило бы правило записи в путь `/mpu` (замер 2026-09-09).
 *
 * @param denoJsonc текст `deno.jsonc` целиком
 * @param target куда собирать и чем раскрывать переменные
 */
export function compileArgs(
  denoJsonc: string,
  target: CompileTarget,
): string[] {
  const task = denoJsonc.match(/"build":\s*"([^"]*)"/)?.[1];
  if (task === undefined) {
    throw new BuildTaskError("в deno.jsonc нет задачи build");
  }
  const args = task.split(/\s+/).slice(1).map((arg) =>
    arg.replaceAll("$HOME", target.home).replaceAll(
      "$XDG_CONFIG_HOME",
      target.configHome,
    )
  );
  const out = args.indexOf("-o");
  if (out < 0) throw new BuildTaskError("в задаче build нет -o");
  args[out + 1] = target.out;
  return args;
}
