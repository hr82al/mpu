/**
 * Резолв пути к .xlsx: первый непустой из `--file` → env `MPU_XLSX` →
 * конфиг-ключ `xlsx.default`; значение сначала пробуется как алиас,
 * если похоже на имя алиаса (контракт спеки xlsx.md). Модуль чистый:
 * все источники передаются параметрами.
 */

import { UsageError } from "../command/mod.ts";

/** Идентификатор источника пути. */
export type SourceKind = "flag" | "env" | "config";

/** Итог проверки одного источника (для `resolve --json`). */
export interface CheckedSource {
  readonly source: SourceKind;
  readonly label: string;
  /** Сырое значение источника; пустое или незаданное — null. */
  readonly value: string | null;
  readonly used: boolean;
}

/** Победивший источник и готовый к использованию путь. */
export interface ResolvedPath {
  /** Абсолютный нормализованный путь. */
  readonly path: string;
  readonly source: SourceKind;
  /** Имя алиаса, через который пришёл путь; прямой путь — без ключа. */
  readonly alias?: string;
}

/** Полный итог резолва: победитель (или null) и все три источника. */
export interface ResolveReport {
  readonly resolved: ResolvedPath | null;
  readonly checked: readonly CheckedSource[];
}

/** Входы резолва; все источники передаются явно (модуль чистый). */
export interface ResolveSources {
  readonly flagValue: string | undefined;
  readonly envValue: string | undefined;
  readonly configValue: string | undefined;
  /** Путь алиаса по имени; не найден — undefined. */
  readonly aliasPath: (name: string) => string | undefined;
  readonly cwd: string;
  /** Домашний каталог для «~»; неизвестен — тильда не раскрывается. */
  readonly home: string | undefined;
}

const LABELS: Readonly<Record<SourceKind, string>> = {
  flag: "--file/-f",
  env: "env MPU_XLSX",
  config: "config xlsx.default",
};

/** Проверяет источники по порядку; первый непустой побеждает. */
export function resolveXlsxPath(sources: ResolveSources): ResolveReport {
  const raw: readonly (readonly [SourceKind, string | undefined])[] = [
    ["flag", sources.flagValue],
    ["env", sources.envValue],
    ["config", sources.configValue],
  ];
  let resolved: ResolvedPath | null = null;
  const checked = raw.map(([source, value]) => {
    let used = false;
    if (value !== undefined && value !== "" && resolved === null) {
      resolved = resolveValue(value, source, sources);
      used = true;
    }
    return {
      source,
      label: LABELS[source],
      value: value === undefined || value === "" ? null : value,
      used,
    };
  });
  return { resolved, checked };
}

/**
 * Похоже ли значение на имя алиаса: нет `/` и `\`, не начинается с
 * `~`, не кончается на `.xlsx`, матчит `[A-Za-z0-9_.-]+`.
 */
export function isAliasLike(value: string): boolean {
  return !value.includes("/") &&
    !value.includes("\\") &&
    !value.startsWith("~") &&
    !value.endsWith(".xlsx") &&
    /^[A-Za-z0-9_.-]+$/.test(value);
}

/** Ошибка «путь не задан» с текстом из спеки (exit 2). */
export function pathNotSetError(): UsageError {
  return new UsageError(
    "путь к .xlsx не задан. Проверены (по порядку): --file/-f, " +
      "env MPU_XLSX, config xlsx.default",
    {
      hint: "--file <путь>, export MPU_XLSX=<путь> " +
        "или задай config xlsx.default",
    },
  );
}

function resolveValue(
  value: string,
  source: SourceKind,
  sources: ResolveSources,
): ResolvedPath {
  if (isAliasLike(value)) {
    const aliasTarget = sources.aliasPath(value);
    if (aliasTarget !== undefined) {
      return {
        path: absolutize(aliasTarget, sources),
        source,
        alias: value,
      };
    }
    // Алиас не найден: значение молча трактуется как относительный
    // путь (отклонение-preserve из спеки — нейтральность harness-
    // команды; явная ошибка «alias not found» — идея в журнал).
  }
  return { path: absolutize(value, sources), source };
}

/** Раскрывает «~», приводит к абсолютному от cwd и нормализует. */
function absolutize(path: string, sources: ResolveSources): string {
  let expanded = path;
  if (sources.home !== undefined) {
    if (path === "~") expanded = sources.home;
    else if (path.startsWith("~/")) expanded = sources.home + path.slice(1);
  }
  const joined = expanded.startsWith("/")
    ? expanded
    : `${sources.cwd}/${expanded}`;
  return normalizePosix(joined);
}

/** Нормализация POSIX-пути: `.`/`..`/повторные `/` (как abspath). */
function normalizePosix(path: string): string {
  const stack: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join("/")}`;
}
