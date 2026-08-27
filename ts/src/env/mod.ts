/**
 * Слой политики над форматом env-файла (`docs/specs/platform/env-file.md`):
 * путь файла, ленивый однократный снапшот значений, обязательные ключи,
 * атомарная запись. Окружение процесса слой не читает (решение
 * 2026-08-05, см. «Ввод/вывод» и «Известные отклонения» спеки) — значения
 * приходят только из файла. Модуль не трогает файловую систему напрямую —
 * доступ к диску приходит через `EnvFileStore`, который передаёт
 * вызывающий слой (`src/runtime/`).
 */

import { DomainError, type EnvFile } from "../command/mod.ts";
import { assignEnvValue, EnvValueError, parseEnvFile } from "./format.ts";

/** Доступ к env-файлу на диске: чтение снапшотом, атомарная запись. */
export interface EnvFileStore {
  readonly path: string;
  /** Текст файла; файла нет — undefined. */
  readonly readSync: () => string | undefined;
  /** Атомарная замена: tmp + rename, права 0600. */
  readonly write: (text: string) => Promise<void>;
}

/** Путь env-файла: XDG_CONFIG_HOME (непустая) → $HOME/.config; иначе undefined. */
export function envFilePath(
  readEnv: (name: string) => string | undefined,
): string | undefined {
  const xdgConfigHome = readEnv("XDG_CONFIG_HOME");
  if (xdgConfigHome !== undefined && xdgConfigHome !== "") {
    return `${xdgConfigHome}/mpu/.env`;
  }
  const home = readEnv("HOME");
  // Пустая `HOME` равнозначна незаданной — как для `XDG_CONFIG_HOME` выше
  // и как в соседнем `defaultConfigDir` (`src/runtime/mod.ts`):
  // одно и то же правило для обеих переменных, откуда бы путь ни строился.
  return home === undefined || home === ""
    ? undefined
    : `${home}/.config/mpu/.env`;
}

// Путь для текста ошибки `require`, когда файла-хранилища нет вовсе
// (`store === undefined`, обычно из-за неопределённого HOME — см.
// `envFilePath`). Сообщению всё равно нужен путь: берём дефолт спеки
// буквально, а не пытаемся его вычислить второй раз из `readEnv`.
const DEFAULT_PATH_HINT = "~/.config/mpu/.env";

/**
 * Разобранный снапшот файла: читается не более одного раза за процесс.
 * Названа не «Snapshot» — так в глоссарии уже зовётся другой термин
 * (полная перезапись кэш-БД), а это локальная деталь модуля.
 */
interface FileSnapshot {
  readonly text: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Текст файла после записи `name=value`; переводит `EnvValueError` формата
 * в `DomainError` с именем ключа. Перевод строки или одинарная кавычка в
 * значении — предвидимый ввод пользователя (значение для секрета набрано
 * руками или вставлено из буфера), а не сбой программы: точка входа
 * (`main.ts`) печатает `DomainError` пользователю как есть, а прочие
 * ошибки — общим «unexpected error». `store.write` до этого вызова не
 * доходит, файл не тронут.
 */
function buildNextText(text: string, name: string, value: string): string {
  try {
    return assignEnvValue(text, name, value);
  } catch (err) {
    if (!(err instanceof EnvValueError)) throw err;
    // Причина называется в самом сообщении, а не только в `cause`: точка
    // входа (`main.ts`) печатает пользователю `err.message` как есть и
    // цепочку `cause` не разворачивает — без этого пользователь не узнал
    // бы, что помешал перевод строки или одинарная кавычка в значении.
    throw new DomainError(
      `cannot write env value for ${name}: value contains a newline or a single quote`,
      { cause: err },
    );
  }
}

/** Слой поверх файла; store отсутствует — файла нет. */
export function makeEnvFile(store: EnvFileStore | undefined): EnvFile {
  // Ленивый снапшот: до первого обращения store не читается вовсе, а
  // после — не перечитывается за всю жизнь процесса (инвариант спеки
  // «изменение файла извне не влияет на уже запущенный процесс»). `set`
  // строит новый текст поверх этого же снапшота и обновляет его после
  // успешной записи — так `get` сразу после `set` не ходит на диск.
  let snapshot: FileSnapshot | undefined;

  function snapshotOf(): FileSnapshot {
    if (snapshot === undefined) {
      const text = store?.readSync() ?? "";
      snapshot = { text, values: parseEnvFile(text) };
    }
    return snapshot;
  }

  function get(name: string): string | undefined {
    return snapshotOf().values[name];
  }

  /** Копия, а не сам снапшот: иначе вызывающий правил бы разбор файла. */
  function values(): Readonly<Record<string, string>> {
    return { ...snapshotOf().values };
  }

  function require(name: string): string {
    const value = get(name);
    if (value !== undefined && value !== "") return value;
    const path = store?.path ?? DEFAULT_PATH_HINT;
    // Текст — внешний контракт (`env-file.md`, раздел «Ввод/вывод»):
    // дословная строка, которую годами видят пользователи существующей
    // машины. Заглавная буква и точки на конце не соответствуют стилю
    // ошибок проекта (CLAUDE.md, «Ошибки») — здесь это осознанное
    // исключение, а не небрежность.
    throw new DomainError(
      `environment variable ${name} is not set. ` +
        `Add it to ${path} or export in shell.`,
    );
  }

  async function set(name: string, value: string): Promise<void> {
    if (store === undefined) {
      throw new DomainError("cannot write env file: no config directory");
    }
    const nextText = buildNextText(snapshotOf().text, name, value);
    const nextValues = parseEnvFile(nextText);
    // Запись (`assignEnvValue`) заменяет первую строку ключа — так велит
    // спека; разбор (`parseEnvFile`) отдаёт значение последней строки —
    // так ведёт себя живой разборщик, с которым паритет обязателен. На
    // файле без дубликатов ключа обе половины согласны. На файле с
    // дубликатом они расходятся молча: `store.write` записал бы значение,
    // которое `get` тут же не увидел бы — более поздняя строка перекрыла
    // бы его при следующем разборе. Меняя ни одну из половин нельзя (обе
    // зафиксированы), поэтому расхождение ловится здесь и отказывает
    // громко, до того как `store.write` тронет диск.
    if (nextValues[name] !== value) {
      throw new DomainError(
        `cannot write env value for ${name}: a later line in ` +
          `${store.path} repeats the key and would override the write`,
      );
    }
    await store.write(nextText);
    snapshot = { text: nextText, values: nextValues };
  }

  return { get, require, set, values };
}
