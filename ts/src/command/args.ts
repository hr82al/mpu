/**
 * Разбор argv по описанию входов команды. Описание выводится из схемы
 * аргументов, поэтому множества имён argv и схемы совпадают по
 * построению (инвариант 4 контракта), а не по дисциплине.
 *
 * Свой парсер, а не сторонний: семантика спек (повторы `--from`
 * накапливаются, `-` — позиционный маркер stdin, `--` завершает флаги) и
 * точные тексты ошибок важнее экономии на полусотне строк.
 */

import { UsageError } from "./errors.ts";

/** Как вход команды записывается в argv. */
export interface InputForm {
  /** Короткое имя без «-», одна буква. */
  readonly short?: string;
  /**
   * Позиционная запись: `one` — один аргумент по порядку объявления,
   * `rest` — все оставшиеся. Без этого поля вход читается как флаг.
   */
  readonly positional?: "one" | "rest";
}

/** Вход команды глазами разбора argv. */
export interface InputSpec {
  /** Имя поля схемы; оно же длинное имя флага. */
  readonly name: string;
  /** `boolean` — флаг без значения, `strings` — накапливается. */
  readonly kind: "boolean" | "string" | "strings";
  readonly form: InputForm;
}

/** Сырые значения до проверки схемой: строки argv как они пришли. */
export type RawArgs = Readonly<Record<string, string | boolean | string[]>>;

/**
 * Разбирает argv в сырой объект аргументов. Проверку типов, значений по
 * умолчанию и ограничений делает схема команды — здесь только формы
 * записи и ошибки, которые схеме не видны (неизвестная опция, лишний
 * позиционный аргумент).
 */
export function parseArgv(
  argv: readonly string[],
  specs: readonly InputSpec[],
  helpHint: string,
): RawArgs {
  const out: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  const flags = specs.filter((spec) => spec.form.positional === undefined);

  let index = 0;
  const nextValue = (): string | undefined =>
    index < argv.length ? argv[index++] : undefined;

  while (index < argv.length) {
    const arg = argv[index];
    index++;
    if (arg === "--") {
      positional.push(...argv.slice(index));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      const spec = flags.find((s) => s.name === name);
      if (spec === undefined) throw unknownOption(arg, helpHint);
      record(out, spec, inline, nextValue, helpHint);
      continue;
    }
    const spec = arg.length === 2
      ? flags.find((s) => s.form.short === arg[1])
      : undefined;
    if (spec === undefined) throw unknownOption(arg, helpHint);
    record(out, spec, undefined, nextValue, helpHint);
  }

  bindPositional(out, specs, positional, helpHint);
  return out;
}

function record(
  out: Record<string, string | boolean | string[]>,
  spec: InputSpec,
  inline: string | undefined,
  nextValue: () => string | undefined,
  helpHint: string,
): void {
  if (spec.kind === "boolean") {
    if (inline !== undefined) {
      throw new UsageError(`option --${spec.name} does not take a value`, {
        hint: helpHint,
      });
    }
    out[spec.name] = true;
    return;
  }
  const value = inline ?? nextValue();
  if (value === undefined) {
    throw new UsageError(`option --${spec.name} requires a value`, {
      hint: helpHint,
    });
  }
  if (spec.kind === "string") {
    // «Последний побеждает»: повтор строкового флага не накапливается.
    out[spec.name] = value;
    return;
  }
  const previous = out[spec.name];
  out[spec.name] = Array.isArray(previous) ? [...previous, value] : [value];
}

function bindPositional(
  out: Record<string, string | boolean | string[]>,
  specs: readonly InputSpec[],
  positional: readonly string[],
  helpHint: string,
): void {
  let taken = 0;
  for (const spec of specs) {
    if (spec.form.positional === undefined) continue;
    if (spec.form.positional === "rest") {
      out[spec.name] = positional.slice(taken);
      taken = positional.length;
      continue;
    }
    if (taken < positional.length) out[spec.name] = positional[taken++];
  }
  if (taken < positional.length) {
    throw new UsageError(`unexpected argument "${positional[taken]}"`, {
      hint: helpHint,
    });
  }
}

function unknownOption(arg: string, helpHint: string): UsageError {
  return new UsageError(`unknown option "${arg}"`, { hint: helpHint });
}
