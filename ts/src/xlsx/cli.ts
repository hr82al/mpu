/**
 * Разбор флагов подкоманд xlsx. Свой минимальный парсер: семантика
 * спеки (повторы `--from` накапливаются, `-` — позиционный маркер
 * stdin, `--` завершает флаги) и точные тексты ошибок важнее экономии
 * на 60 строках; сторонний парсер пришлось бы огибать.
 */

import { UsageError } from "./errors.ts";

/** Описание одного флага подкоманды. */
export interface OptionSpec {
  /** Длинное имя без «--»; оно же ключ результата. */
  readonly long: string;
  /** Короткое имя без «-», одна буква. */
  readonly short?: string;
  readonly kind: "boolean" | "string";
}

/** Результат разбора аргументов подкоманды. */
export interface ParsedOptions {
  /** Встреченные булевы флаги по длинному имени. */
  readonly flags: ReadonlySet<string>;
  /** Значения строковых флагов по длинному имени, в порядке ввода. */
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly positional: readonly string[];
}

/** Последнее значение строкового флага («последний побеждает»). */
export function lastValue(
  opts: ParsedOptions,
  long: string,
): string | undefined {
  const all = opts.values.get(long);
  return all === undefined ? undefined : all[all.length - 1];
}

/** Разбирает аргументы подкоманды. Ошибки ввода — `UsageError`. */
export function parseOptions(
  args: readonly string[],
  specs: readonly OptionSpec[],
): ParsedOptions {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positional: string[] = [];

  const record = (
    spec: OptionSpec,
    inline: string | undefined,
    next: () => string | undefined,
  ): void => {
    if (spec.kind === "boolean") {
      if (inline !== undefined) {
        throw new UsageError(`option --${spec.long} does not take a value`, {
          hint: "--help",
        });
      }
      flags.add(spec.long);
      return;
    }
    const value = inline ?? next();
    if (value === undefined) {
      throw new UsageError(`option --${spec.long} requires a value`, {
        hint: "--help",
      });
    }
    const list = values.get(spec.long);
    if (list === undefined) values.set(spec.long, [value]);
    else list.push(value);
  };

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    index++;
    if (arg === "--") {
      positional.push(...args.slice(index));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const next = (): string | undefined =>
      index < args.length ? args[index++] : undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      const spec = specs.find((s) => s.long === name);
      if (spec === undefined) throw unknownOption(arg);
      record(spec, inline, next);
      continue;
    }
    const spec = arg.length === 2
      ? specs.find((s) => s.short === arg[1])
      : undefined;
    if (spec === undefined) throw unknownOption(arg);
    record(spec, undefined, next);
  }
  return { flags, values, positional };
}

function unknownOption(arg: string): UsageError {
  return new UsageError(`unknown option "${arg}"`, { hint: "--help" });
}
