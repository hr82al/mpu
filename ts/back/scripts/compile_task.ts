/**
 * Аргументы сборки монолита: берутся из задачи `compile:monolith`
 * (`deno.jsonc`) и больше ниоткуда (`platform/cutover.md`). Живут рядом
 * со своим единственным потребителем — прогоном `smoke`: список
 * `--allow-*` есть договор о правах программы, и вторая его копия не
 * показалась бы ни компилятору, ни тесту — бинарь просто собрался бы с
 * правами, которых никто не объявлял.
 */

/** Имя задачи сборки монолита: названо здесь один раз. */
export const MONOLITH_TASK = "compile:monolith";

/** Задачи сборки в `deno.jsonc` нет либо она не той формы. */
export class CompileTaskError extends Error {
  override name = "CompileTaskError";
}

/**
 * Чем раскрываются переменные строки задачи и куда кладётся результат.
 * Каталоги — параметры, а не окружение процесса: прогон собирает бинарь
 * подставному `HOME`, а не своему.
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
 * Аргументы `deno` для сборки монолита. Подменяются только путь вывода
 * и два каталога окружения; список прав переносится дословно.
 *
 * `deno task` подставляет незаданную переменную пустой строкой, поэтому
 * умолчание `$XDG_CONFIG_HOME` — забота вызывающего: пустое значение
 * превратило бы правило записи в путь `/mpu` (замер 2026-09-09).
 *
 * @param denoJsonc текст `deno.jsonc` целиком
 * @param target куда собирать и чем раскрывать переменные
 * @throws CompileTaskError — задачи нет или у неё нет `-o`
 */
export function compileArgs(
  denoJsonc: string,
  target: CompileTarget,
): string[] {
  const task = denoJsonc.match(
    new RegExp(`"${MONOLITH_TASK}":\\s*"([^"]*)"`),
  )?.[1];
  if (task === undefined) {
    throw new CompileTaskError(`в deno.jsonc нет задачи ${MONOLITH_TASK}`);
  }
  const args = task.split(/\s+/).slice(1).map((arg) =>
    arg.replaceAll("$HOME", target.home).replaceAll(
      "$XDG_CONFIG_HOME",
      target.configHome,
    )
  );
  const out = args.indexOf("-o");
  if (out < 0) {
    throw new CompileTaskError(`в задаче ${MONOLITH_TASK} нет -o`);
  }
  args[out + 1] = target.out;
  return args;
}
