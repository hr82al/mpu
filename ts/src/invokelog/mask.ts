/**
 * Строка `$ mpu …` записи журнала (`platform/invoke-log.md`): секреты
 * маскируются до записи и необратимо, остаток кавычится по правилам
 * shell. Маскирование живёт здесь, а не на местах вызова: инвариант
 * «секреты не попадают в журнал» должен держаться одним куском кода.
 */

/** Маска-литерал; значение секрета в запись не попадает ни в каком виде. */
export const REDACTED = "REDACTED";

/**
 * Части имени опции, делающие её значение секретом. Список — дословно
 * из спеки; сравнение без учёта регистра.
 */
const SECRET_MARKERS: readonly string[] = [
  "password",
  "token",
  "secret",
  "api-key",
  "api_key",
  "session",
];

/** Опции, чьё значение — тело JSON: там маскируются ключи внутри. */
const BODY_OPTIONS: readonly string[] = ["-b", "--body"];

/**
 * Символы, не требующие кавычек. Набор повторяет цитирование оригинала:
 * буквы (любого алфавита) и цифры плюс `@%+=:,./-`.
 */
const SAFE_WORD = /^[\p{L}\p{N}_@%+=:,./-]+$/u;

/** Пометка команды: аргументы в запись не попадают ни в каком виде. */
export interface MaskOptions {
  /**
   * Путь помеченной команды. Задан — всё в argv, что не встало на своё
   * место сегментов пути по порядку, заменяется маской независимо от
   * имён: у помеченной команды персонален сам аргумент, а не значение
   * опции с говорящим именем (`platform/invoke-log.md`, «Инварианты»).
   *
   * Индекс здесь не подошёл бы: путь в argv не обязан быть непрерывным
   * префиксом — общий `--json` встаёт между его сегментами
   * (`mpu telegram --json log …`, `src/entrypoint/mod_test.ts`,
   * `xlsx --json alias ls`), и маска по длине пути срезала бы часть
   * самого пути вместо аргумента.
   */
  readonly path?: readonly string[];
}

/** Строка команды CLI: литеральное `mpu`, затем argv после маскирования. */
export function commandLine(
  argv: readonly string[],
  options: MaskOptions = {},
): string {
  const masked = options.path === undefined
    ? maskArgv(argv)
    : maskAfterPath(argv, options.path);
  return ["mpu", ...masked.map(shellQuote)].join(" ");
}

/**
 * argv, где сегменты пути (по порядку, не обязательно подряд) остаются
 * как есть, а всё остальное — маска. Совпадение ищется жадно слева
 * направо: как только очередной элемент argv равен следующему
 * непройденному сегменту пути, он оставляется и путь считается на
 * шаг ближе к концу; после того как путь пройден целиком, дальнейшие
 * элементы маскируются все без исключения, даже случайно совпавшие с
 * его словами (это уже аргументы, а не путь).
 */
function maskAfterPath(
  argv: readonly string[],
  path: readonly string[],
): readonly string[] {
  let matched = 0;
  return argv.map((arg) => {
    if (matched < path.length && arg === path[matched]) {
      matched += 1;
      return arg;
    }
    return REDACTED;
  });
}

/**
 * Строка команды вызова тула MCP-сервером: путь команды через пробел и
 * JSON аргументов одной строкой (спека, «Запись вызова через
 * MCP-сервер»). У помеченной команды JSON заменяется маской целиком:
 * персональна вся полезная нагрузка, а не отдельные её ключи.
 */
export function toolCommandLine(
  path: readonly string[],
  input: unknown,
  options: { readonly masked?: boolean } = {},
): string {
  if (options.masked === true) return ["mpu", ...path, REDACTED].join(" ");
  const json = JSON.stringify(maskJsonValue(input).value) ?? "null";
  return ["mpu", ...path, shellQuote(json)].join(" ");
}

/**
 * Текст JSON с замаскированными значениями секретных ключей. Невалидный
 * JSON возвращается как есть — разбирать его нечем, а выбрасывать
 * пользовательский ввод из записи журнал не вправе. Совпадений нет —
 * текст тоже дословный: пересборка меняла бы форматирование ни за что.
 */
export function maskJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Не JSON — трогать нечего: маскировать в этом тексте мы не умеем,
    // и это его единственное следствие (спека, «Инварианты»).
    return text;
  }
  const masked = maskJsonValue(parsed);
  return masked.changed ? JSON.stringify(masked.value) : text;
}

/** Результат обхода: значение и было ли в нём что маскировать. */
interface Masked {
  readonly value: unknown;
  readonly changed: boolean;
}

/** Рекурсивное маскирование значений секретных ключей внутри JSON. */
function maskJsonValue(value: unknown): Masked {
  if (Array.isArray(value)) {
    const items = value.map(maskJsonValue);
    return {
      value: items.map((item) => item.value),
      changed: items.some((item) => item.changed),
    };
  }
  if (typeof value !== "object" || value === null) {
    return { value, changed: false };
  }
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    if (isSecretName(key)) {
      out[key] = REDACTED;
      changed = true;
      continue;
    }
    const masked = maskJsonValue(item);
    out[key] = masked.value;
    changed = changed || masked.changed;
  }
  return { value: out, changed };
}

/**
 * argv после маскирования. Разбор argv здесь свой и нарочно грубый: у
 * записи журнала нет схемы команды, а секрет обязан быть замаскирован и
 * у команды, которой реестр не знает.
 */
function maskArgv(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  // Что делать со следующим аргументом: он значение опции, названной
  // предыдущим словом.
  let pending: "none" | "secret" | "body" = "none";
  for (const arg of argv) {
    if (pending === "secret") {
      out.push(REDACTED);
      pending = "none";
      continue;
    }
    if (pending === "body") {
      out.push(maskJsonText(arg));
      pending = "none";
      continue;
    }
    if (!arg.startsWith("-")) {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq < 0) {
      pending = isSecretName(arg)
        ? "secret"
        : isBodyOption(arg)
        ? "body"
        : "none";
      out.push(arg);
      continue;
    }
    const name = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (isSecretName(name)) out.push(`${name}=${REDACTED}`);
    else if (isBodyOption(name)) out.push(`${name}=${maskJsonText(value)}`);
    else out.push(arg);
  }
  return out;
}

/** Имя опции называет секрет: сравнение по подстроке, без учёта регистра. */
function isSecretName(name: string): boolean {
  const lower = name.replace(/^-+/, "").toLowerCase();
  return SECRET_MARKERS.some((marker) => lower.includes(marker));
}

function isBodyOption(name: string): boolean {
  return BODY_OPTIONS.includes(name);
}

/** Кавычение по правилам shell: слово безопасных символов — как есть. */
function shellQuote(word: string): string {
  if (SAFE_WORD.test(word)) return word;
  // Внутри одинарных кавычек экранирования нет: сама кавычка вставляется
  // разрывом строки — `'` → `'"'"'`.
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}
