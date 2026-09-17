/**
 * Чтение машинного слепка дерева команд Python-версии
 * (`docs/specs/fixtures/platform/registry/tree.json`).
 *
 * Слепок пережил сам маршрут `legacy`: команды по нему больше не
 * исполняются (порция 97), но снимок остаётся свидетельством того, что
 * в прежней реализации было, — по нему сверяются однострокѝ и состав
 * переехавших групп, и по нему же видно, какие имена решено не
 * переносить (`dropped.ts`).
 *
 * Разбор строгий: слепок — снятая фикстура, и молчаливое «поле не то,
 * возьмём умолчание» превратило бы порчу файла в тихо неверную сверку.
 */

/** Версия формата слепка, которую понимает этот разбор. */
export const MANIFEST_VERSION = 2;

/** Слепок не разобран: формат не тот, и догадываться не за что. */
export class ManifestError extends Error {
  override name = "ManifestError";
}

/** Узел дерева: путь, однострока и полная справка. */
export interface ManifestNode {
  readonly path: readonly string[];
  readonly summary: string;
  readonly help: string;
  /** Промежуточный уровень, а не команда. */
  readonly group?: boolean;
}

/** Разобранный слепок. */
export interface Manifest {
  readonly manifestVersion: number;
  readonly mpuVersion: string;
  readonly commands: readonly ManifestNode[];
}

/** Разбирает слепок; несоответствие формату — отказ, а не умолчание. */
export function readManifest(raw: unknown): Manifest {
  const root = asRecord(raw, "слепок");
  const version = root["manifestVersion"];
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `слепок: manifestVersion ${String(version)}, ожидается ` +
        `${MANIFEST_VERSION}`,
    );
  }
  const mpuVersion = root["mpuVersion"];
  if (typeof mpuVersion !== "string") {
    throw new ManifestError("слепок: mpuVersion не строка");
  }
  const commands = root["commands"];
  if (!Array.isArray(commands)) {
    throw new ManifestError("слепок: commands не массив");
  }
  return {
    manifestVersion: version,
    mpuVersion,
    commands: commands.map((node, index) => readNode(node, index)),
  };
}

function readNode(raw: unknown, index: number): ManifestNode {
  const what = `слепок: команда ${index}`;
  const node = asRecord(raw, what);
  const path = node["path"];
  if (
    !Array.isArray(path) || path.length === 0 ||
    path.some((part) => typeof part !== "string")
  ) {
    throw new ManifestError(`${what}: path не массив строк`);
  }
  const summary = node["summary"];
  const help = node["help"];
  if (typeof summary !== "string" || typeof help !== "string") {
    throw new ManifestError(`${what}: summary или help не строка`);
  }
  const group = node["group"];
  if (group !== undefined && typeof group !== "boolean") {
    throw new ManifestError(`${what}: group не булев`);
  }
  return {
    path: path as readonly string[],
    summary,
    help,
    ...(group === undefined ? {} : { group }),
  };
}

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestError(`${what}: не объект`);
  }
  return raw as Record<string, unknown>;
}
