/**
 * Команда `mpu config` (`docs/specs/platform/config.md`): чтение и
 * запись локальных предпочтений.
 *
 * Источников значения два — запись в таблице `config` кэш-БД и
 * умолчание потребителя. Переменных окружения среди них нет вовсе
 * (решение пользователя 2026-08-27), поэтому и ветки под источник
 * `env` в коде не существует: мёртвая ветка под несуществующий слой
 * обещала бы читателю то, чего нет.
 *
 * Команда пишущая целиком: тем же вызовом, которым читают, и задают
 * значение — различает их только наличие второго аргумента. Поэтому у
 * неё политика `rw`, а не «ro на чтение»: у контракта одна политика на
 * команду, и делить её нечем.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  UsageError,
} from "../command/mod.ts";
import {
  configValue,
  readPreferences,
  setConfigValue,
  unsetConfigValue,
} from "./mod.ts";
import {
  CONFIG_KEYS,
  type ConfigKey,
  configKey,
  configKeyNames,
} from "./registry.ts";

const argsSchema = z.object({
  key: z.string().optional().describe("имя ключа реестра"),
  value: z.string().optional().describe("новое значение ключа"),
  unset: z.boolean().default(false).describe(
    "удалить запись ключа: значение вернётся к умолчанию",
  ),
  json: z.boolean().default(false).describe("машиночитаемый вывод"),
});

const entrySchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.null()]).describe(
    "действующее значение: из хранилища либо умолчание",
  ),
  source: z.enum(["config", "default"]).describe("откуда взято значение"),
  default: z.union([z.string(), z.null()]).describe("умолчание потребителя"),
  description: z.string(),
});

const resultSchema = z.object({
  entries: z.array(entrySchema).describe(
    "ключи реестра по порядку объявления",
  ),
  action: z.enum(["list", "get", "set", "unset"]).describe(
    "что сделал вызов: чтение, запись или сброс",
  ),
});

type ConfigArgs = z.infer<typeof argsSchema>;
type ConfigResult = z.infer<typeof resultSchema>;
type ConfigEntry = z.infer<typeof entrySchema>;

/** Срез порта: всё состояние команды — таблица кэш-БД. */
export type ConfigIo = Pick<CommandIo, "openCacheDb">;

/** Отказ на имя вне реестра: закрытый список — часть контракта. */
function unknownKey(name: string): UsageError {
  return new UsageError(`unknown config key: "${name}"`, {
    hint: `допустимые ключи: ${configKeyNames()}`,
  });
}

/** Действующее значение ключа: запись хранилища, иначе умолчание. */
function entryOf(entry: ConfigKey, stored: string | undefined): ConfigEntry {
  const set = stored !== undefined;
  return {
    key: entry.key,
    value: set ? stored : entry.fallback ?? null,
    // Источника `env` не существует, поэтому и третьего значения здесь
    // нет: либо запись, либо умолчание.
    source: set ? "config" : "default",
    default: entry.fallback ?? null,
    description: entry.description,
  };
}

/**
 * Значение int-ключа проверяется ДО записи: хранилище общее с рабочей
 * реализацией, и «7337abc» в нём сломало бы не наш вызов, а следующий
 * чужой.
 */
function assertValue(entry: ConfigKey, value: string): void {
  if (value === "") {
    // Пустая строка в таблице читается как «записи нет»: она осела бы
    // невидимкой — `mpu config` её не показывает, а место занято.
    // Обычный источник такого вызова — `mpu config KEY "$VAR"` с
    // пустой переменной, и промолчать здесь значит потерять намерение.
    throw new UsageError(
      `${entry.key}: пустое значение не задаётся; сбросить ключ — --unset`,
    );
  }
  if (entry.type !== "int") return;
  if (!/^-?\d+$/.test(value)) {
    throw new UsageError(
      `${entry.key} ожидает целое число, получено "${value}"`,
    );
  }
  const range = entry.range;
  if (range === undefined) return;
  const number = Number(value);
  if (number < range.min || number > range.max) {
    // Отказ, а не запись: значение вне границ потребитель молча
    // заменит умолчанием, и `mpu config` станет показывать то, чего
    // нет (`platform/config.md`, отклонение про mcp.port).
    throw new UsageError(
      `${entry.key} ожидает порт ${range.min}–${range.max}, ` +
        `получено "${value}"`,
    );
  }
}

/**
 * Ход вызова: список, чтение одного ключа, запись либо сброс.
 *
 * Обёртка вокруг синхронной работы: у контракта команда возвращает
 * промис, и отказ обязан приходить отказом промиса — синхронный бросок
 * из функции, объявленной промисом, вызывающий поймал бы не тем
 * `catch`.
 */
export function runConfig(
  args: ConfigArgs,
  io: ConfigIo,
): Promise<ConfigResult> {
  try {
    return Promise.resolve(configResult(args, io));
  } catch (err) {
    // Работа синхронная, а контракт обещает промис: отказ обязан
    // приходить отказом промиса — иначе вызывающий, написавший
    // `.catch`, отказа не увидит вовсе.
    return Promise.reject(err);
  }
}

/**
 * Сама работа. Ввод разбирается ЦЕЛИКОМ до хранилища: спека требует
 * exit 2 на имя вне реестра и нечисловое значение, а открытие кэш-БД
 * создаёт каталог и файл — то есть отказ ввода оставлял бы след и, на
 * машине без HOME, подменялся бы отказом инфраструктуры (exit 1).
 */
function configResult(args: ConfigArgs, io: ConfigIo): ConfigResult {
  if (args.unset && args.key === undefined) {
    throw new UsageError("--unset требует имя ключа");
  }
  const entry = args.key === undefined ? undefined : configKey(args.key);
  if (args.key !== undefined && entry === undefined) throw unknownKey(args.key);
  if (entry !== undefined && args.value !== undefined) {
    if (args.unset) {
      // Молча проглотить значение нельзя: оператор просил два разных
      // действия сразу, и какое из них он имел в виду — неизвестно.
      throw new UsageError("--unset не сочетается со значением");
    }
    assertValue(entry, args.value);
  }

  // Чтение обходится без записи, поэтому недостижимое хранилище (нет
  // HOME — нет пути к файлу) для него равнозначно пустому: спека велит
  // в его отсутствие работать по умолчаниям.
  if (entry === undefined) {
    return {
      entries: readPreferences(
        io,
        (db) => CONFIG_KEYS.map(readWith(db)),
        noStore(),
      ),
      action: "list",
    };
  }
  if (args.value === undefined && !args.unset) {
    const [only] = readPreferences(
      io,
      (db) => [readWith(db)(entry)],
      [entryOf(entry, undefined)],
    );
    return { entries: [only], action: "get" };
  }

  // Дальше — запись: без хранилища она невозможна, и отказ уместен.
  using db = io.openCacheDb();
  if (args.unset) {
    // Идемпотентно: записи могло не быть вовсе, и это тоже успех.
    unsetConfigValue(db, entry.key);
    return { entries: [readWith(db)(entry)], action: "unset" };
  }
  // Значение кладётся буквально: «007» остаётся «007». Нормализация
  // развела бы наше хранилище с рабочим на ровном месте.
  setConfigValue(db, entry.key, args.value as string);
  return { entries: [readWith(db)(entry)], action: "set" };
}

/** Чтение ключа поверх открытой БД. */
function readWith(db: CacheDb): (entry: ConfigKey) => ConfigEntry {
  return (entry) => entryOf(entry, configValue(db, entry.key));
}

/** Все ключи по умолчаниям — вид реестра, когда хранилища нет вовсе. */
function noStore(): ConfigEntry[] {
  return CONFIG_KEYS.map((entry) => entryOf(entry, undefined));
}

/** Ширина колонки ключа в списке: по самому длинному имени реестра. */
function keyWidth(entries: readonly ConfigEntry[]): number {
  return Math.max(...entries.map((entry) => entry.key.length));
}

/** Строка списка: ключ, значение и суффикс источника у умолчания. */
function listLine(entry: ConfigEntry, width: number): string {
  const value = entry.value ?? "(unset)";
  // Суффикс печатается только у умолчания: значение из хранилища —
  // обычный случай, и помечать его нечем (`platform/config.md`).
  const suffix = entry.source === "default" ? "  (default)" : "";
  return `${entry.key.padEnd(width)}  ${value}${suffix}\n`;
}

/** Четыре формы вывода: список, одно значение, запись, сброс. */
export function renderConfig(
  result: ConfigResult,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(result.entries, null, 2)}\n`;
  const entry = result.entries[0];
  if (result.action === "list") {
    const width = keyWidth(result.entries);
    return result.entries.map((row) => listLine(row, width)).join("");
  }
  if (result.action === "unset") {
    return `${entry.key} сброшен к дефолту: ${entry.default ?? "(unset)"}\n`;
  }
  if (result.action === "set") return `${entry.key} = ${entry.value}\n`;
  // Чтение одного ключа. Заданное значение печатается всегда; у
  // незаданного печатается умолчание — но только числового ключа: у
  // строкового пустой вывод означает «не задано», и на это опираются
  // скрипты (`[ -z "$(mpu config sheet.default)" ]`, контракт спеки).
  if (entry.source === "config") return `${entry.value}\n`;
  return configKey(entry.key)?.type === "int" ? `${entry.value}\n` : "";
}

export const configCommand = defineCommand({
  path: ["config"],
  errorName: "config",
  summary: "Локальные предпочтения CLI: показать и задать ключи.",
  usage: "mpu config [KEY] [VALUE] [--unset] [--json]",
  help: `Без аргументов печатает все ключи реестра с действующими
значениями; у взятого из умолчания стоит пометка (default), у
заданного — ничего.

mpu config KEY печатает значение: у строкового ключа без записи вывод
пуст (на это опираются скрипты), у числового печатается умолчание.
mpu config KEY VALUE задаёт значение, mpu config --unset KEY удаляет
запись. Повторный --unset — тоже успех: команда идемпотентна.

Ключи (закрытый список): mcp.port, mcp.legacy_bin, sheet.default,
xlsx.default, sheet.cache.tab_ttl, sheet.cache.max_tab_bytes,
sheet.cache.max_total_mb. Имя вне списка — ошибка; записей «на лету» не
появляется. Числовому ключу нечисловое значение задать нельзя — отказ
до записи. Значения хранятся буквально: «007» останется «007».

Переменные окружения на выдачу не влияют: источников два — запись в
хранилище и умолчание.

Хранилище — таблица config кэш-БД ~/.config/mpu/mpu.db, общая с прежней
реализацией: заданное здесь немедленно действует и там.

--json печатает массив {key, value, source, default, description}.

Exit: 0 — успех; 2 — имя вне реестра, нечисловое значение числового
ключа, --unset без ключа; 1 — хранилище недоступно.

Примеры: mpu config; mpu config sheet.default 4326;
mpu config --unset sheet.default`,
  policy: "rw",
  argsSchema,
  forms: { key: { positional: "one" }, value: { positional: "one" } },
  resultSchema,
  run: (args: ConfigArgs, io: ConfigIo) => runConfig(args, io),
  render: (result: ConfigResult, args: ConfigArgs) =>
    renderConfig(result, args.json),
});
