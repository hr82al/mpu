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
  /**
   * Неопознанный токен (`-la`, необъявленный `--flag`) уходит в этот
   * вход вместо ошибки «unknown option». Только вместе с
   * `positional: "rest"` и только там, где хвост argv — чужая командная
   * строка: у `mpu ssh` она исполняется в контейнере, и её флаги
   * разбирать не наше дело (`specs/ssh.md`, «CLI-контракт»).
   */
  readonly keepsUnknown?: true;
}

/** Вход команды глазами разбора argv. */
export interface InputSpec {
  /** Имя поля схемы; оно же длинное имя флага. */
  readonly name: string;
  /**
   * `boolean` — флаг без значения, `strings` и `numbers` —
   * накапливаются повтором флага, `number` — вход объявлен числом; из
   * argv и число, и числовой список приходят текстом, и сам разбор его
   * не трогает — приведение делает слой схемы (`mod.ts`, `numbersOf`),
   * которому известен объявленный тип
   * (`platform/command-contract.md`, «Ввод/вывод»).
   */
  readonly kind: "boolean" | "string" | "strings" | "number" | "numbers";
  readonly form: InputForm;
}

/** Сырые значения до проверки схемой: строки argv как они пришли. */
export type RawArgs = Readonly<Record<string, string | boolean | string[]>>;

/** Настройки разбора, не выводимые из описания входов. */
export interface ParseOptions {
  /**
   * Прятать ли пользовательский ввод из текстов ошибок разбора,
   * подставляя вместо него `REDACTED`. Включается у команды с пометкой
   * `logsArguments: false` (`mod.ts`): её аргумент персонален сам по
   * себе, а секции out/err записи журнала пишутся как обычно — эхо
   * ввода в сообщении об ошибке обошло бы маскирование строки вызова
   * (`platform/invoke-log.md`, «Инварианты»). На экране теряется мало:
   * пользователь видит, что набрал.
   */
  readonly masked?: boolean;
}

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
  options: ParseOptions = {},
): RawArgs {
  const out: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  const flags = specs.filter((spec) => spec.form.positional === undefined);
  const keepsUnknown = specs.some((spec) => spec.form.keepsUnknown === true);
  const masked = options.masked === true;

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
      const known = recordLongFlag(out, arg, flags, nextValue, helpHint, {
        keepsUnknown,
        masked,
      });
      if (!known) positional.push(arg);
      continue;
    }
    const spec = arg.length === 2
      ? flags.find((s) => s.form.short === arg[1])
      : undefined;
    if (spec === undefined) {
      if (!keepsUnknown) throw unknownOption(arg, helpHint, masked);
      positional.push(arg);
      continue;
    }
    record(out, spec, undefined, nextValue, helpHint);
  }

  bindPositional(out, specs, positional, helpHint, masked);
  return out;
}

/**
 * Длинная форма записи — `--name`, `--name=value` и отрицательная
 * `--no-name`. Значение попадает в `out` под именем входа схемы; имя, не
 * объявленное ни прямой, ни отрицательной формой, — ошибка вызова, а при
 * `keepsUnknown` — ответ `false`: токен не наш, вызывающий кладёт его в
 * позиционные.
 */
function recordLongFlag(
  out: Record<string, string | boolean | string[]>,
  arg: string,
  flags: readonly InputSpec[],
  nextValue: () => string | undefined,
  helpHint: string,
  options: { readonly keepsUnknown: boolean; readonly masked: boolean },
): boolean {
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
  const inline = eq < 0 ? undefined : arg.slice(eq + 1);
  const spec = flags.find((s) => s.name === name);
  if (spec !== undefined) {
    record(out, spec, inline, nextValue, helpHint);
    return true;
  }
  // Отрицательная форма булева входа: `--no-images` выключает вход
  // `images`, у которого умолчание «включено» (`specs/kiten-card.md`,
  // CLI-контракт). Отдельным входом схемы она не объявляется — иначе
  // у одного значения было бы два имени.
  const negated = negatedBoolean(flags, name);
  if (negated === undefined) {
    if (options.keepsUnknown) return false;
    throw unknownOption(arg, helpHint, options.masked);
  }
  if (inline !== undefined) throw takesNoValue(`--${name}`, helpHint);
  out[negated.name] = false;
  return true;
}

function record(
  out: Record<string, string | boolean | string[]>,
  spec: InputSpec,
  inline: string | undefined,
  nextValue: () => string | undefined,
  helpHint: string,
): void {
  if (spec.kind === "boolean") {
    if (inline !== undefined) throw takesNoValue(`--${spec.name}`, helpHint);
    out[spec.name] = true;
    return;
  }
  const value = inline ?? nextValue();
  if (value === undefined) {
    throw new UsageError(`option --${spec.name} requires a value`, {
      hint: helpHint,
    });
  }
  if (spec.kind === "string" || spec.kind === "number") {
    // «Последний побеждает»: повтор одиночного флага не накапливается.
    // Приведение числа делает не разбор argv, а слой схемы: здесь ещё
    // неизвестно, чем окажется негодный текст — ошибкой типа или
    // ошибкой смысла.
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
  masked: boolean,
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
    throw new UsageError(
      `unexpected argument ${shown(positional[taken], masked)}`,
      { hint: helpHint },
    );
  }
}

/** Булев вход, выключаемый формой `--no-<имя>`; иное имя — `undefined`. */
function negatedBoolean(
  flags: readonly InputSpec[],
  name: string,
): InputSpec | undefined {
  if (!name.startsWith("no-")) return undefined;
  const spec = flags.find((s) => s.name === name.slice(3));
  return spec?.kind === "boolean" ? spec : undefined;
}

function unknownOption(
  arg: string,
  helpHint: string,
  masked: boolean,
): UsageError {
  return new UsageError(`unknown option ${shown(arg, masked)}`, {
    hint: helpHint,
  });
}

/**
 * Как пользовательский ввод выглядит в тексте ошибки: дословно в
 * кавычках либо `REDACTED` у команды с маскированием. Токен прячется
 * целиком, вместе с частью после «=»: значение опции — тот же ввод.
 */
function shown(value: string, masked: boolean): string {
  return masked ? "REDACTED" : `"${value}"`;
}

function takesNoValue(option: string, helpHint: string): UsageError {
  return new UsageError(`option ${option} does not take a value`, {
    hint: helpHint,
  });
}
