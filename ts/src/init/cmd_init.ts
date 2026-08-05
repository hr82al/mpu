/**
 * Команда `mpu init`, шаги 1–2 (`docs/specs/init.md`, порция А): явный
 * bootstrap схемы кэш-БД, затем discovery контейнеров через Portainer
 * API — конкурентный обход endpoints с записью в
 * `portainer_containers`. Шаги 3–5 (прогрев Loki/Kaiten, вход
 * Telegram) — порция Б; заглушек для них здесь нет (проект реализации
 * порции А), справка называет это честно.
 *
 * Маршрут остаётся `legacy`: команда не публикуется в реестре
 * (`src/registry/`) до приёмки порции Б.
 *
 * Служебные строки шага 1 и ошибок обхода уходят не печатью, а в порт
 * `io.progress`; печатает их точка входа. Инвариант 1 контракта команд
 * («исполнение не печатает», проверка — исполнение не пишет в приёмник
 * вывода процесса) этим не нарушен, но текст контракта такого вывода
 * пока не описывает: вопрос вынесен спецификатору
 * (`.tmp/spec-request-init-a.md`, п. 3).
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import {
  DEFAULT_TIMEOUTS,
  firstLine,
  HEADERS_TIMEOUT_MS,
  listContainers,
  listEndpoints,
  type PortainerAccess,
  type PortainerEndpoint,
  type RequestTimeouts,
  TOTAL_TIMEOUT_MS,
} from "./portainer.ts";
import { classifyContainer } from "./discovery.ts";

const argsSchema = z.object({
  portainer: z.string().optional().describe(
    "базовый URL Portainer API; без флага — PORTAINER_URL в env-файле",
  ),
  "dry-run": z.boolean().default(false).describe(
    "только сводка: кэш-БД не изменяется, ничего не записывается",
  ),
  reset: z.boolean().default(false).describe(
    "перед записью удалить весь прежний кэш контейнеров",
  ),
});

const resultSchema = z.object({
  /** Базовый URL Portainer после нормализации (без хвостовых `/`). */
  portainerUrl: z.string(),
  /** sl-N контейнеры, найденные обходом, по возрастанию server_number. */
  containers: z.array(z.object({
    serverNumber: z.number().int(),
    containerName: z.string(),
    state: z.string(),
    endpointId: z.number().int(),
    endpointName: z.string(),
  })),
  /** Контейнеры без sl-номера, найденные тем же обходом. */
  otherCount: z.number().int(),
  /** Итог `--reset`; null — флаг не задан либо сработал `--dry-run`. */
  reset: z.object({ deleted: z.number().int() }).nullable(),
  /** Итог записи в кэш-БД; null означает `--dry-run` (кэш не тронут). */
  write: z.object({
    written: z.number().int(),
    cacheDbPath: z.string(),
  }).nullable(),
});

/** Разобранные аргументы `mpu init`. */
export type InitArgs = z.infer<typeof argsSchema>;

/** Результат шагов 1–2: из него рендерится сводка stdout. */
export type InitResult = z.infer<typeof resultSchema>;

/** Строка кэша контейнеров (`portainer_containers`, `platform/store.md`). */
interface ContainerRow {
  readonly portainerUrl: string;
  readonly endpointId: number;
  readonly endpointName: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly serverNumber: number | null;
  readonly state: string;
  readonly image: string;
  readonly discoveredAt: number;
}

/** Строка с уже известным номером sl-сервера — сужение `ContainerRow`. */
interface SlContainerRow extends ContainerRow {
  readonly serverNumber: number;
}

function hasServerNumber(row: ContainerRow): row is SlContainerRow {
  return row.serverNumber !== null;
}

const UPSERT_CONTAINER_SQL = `
  INSERT INTO portainer_containers (portainer_url, endpoint_id, endpoint_name,
    container_id, container_name, server_number, state, image, discovered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(portainer_url, endpoint_id, container_id) DO UPDATE SET
    endpoint_name = excluded.endpoint_name,
    container_name = excluded.container_name,
    server_number = excluded.server_number,
    state = excluded.state,
    image = excluded.image,
    discovered_at = excluded.discovered_at
`;

/** Endpoint, обход которого завершился отказом (таймаут в т.ч.). */
interface EndpointFailure {
  readonly id: number;
  readonly name: string;
  readonly reason: string;
}

export const initCommand = defineCommand({
  path: ["init"],
  summary: "первичная инициализация локальной кэш-БД (шаги 1–2 из 5)",
  usage: "mpu init [--portainer TEXT] [--dry-run] [--reset]",
  help: `Порция А: два первых шага из пяти — bootstrap схемы кэш-БД и
discovery контейнеров через Portainer API. Шаги 3–5 (прогрев
Loki/Kaiten, вход Telegram) в этой сборке не реализованы.

Подключение — из env-файла ~/.config/mpu/.env: PORTAINER_API_KEY
обязателен; базовый URL — --portainer, иначе PORTAINER_URL;
PORTAINER_VERIFY_TLS, не равный строке "true", отключает проверку
TLS-сертификата. Каждый вызов ограничен: ${HEADERS_TIMEOUT_MS} ms до
заголовков ответа, ${TOTAL_TIMEOUT_MS} ms на вызов целиком.

Обход endpoints конкурентный; ошибка одного (включая таймаут) идёт в
stderr и не прерывает остальные. Найденное пишется в кэш-БД upsert'ом
по ключу (portainer_url, endpoint_id, container_id); исчезнувшие из
Portainer контейнеры остаются в кэше до --reset, а он удаляет весь
прежний кэш контейнеров перед записью. --dry-run печатает только
сводку и кэш не трогает (схема шага 1 создаётся всегда).

Exit: 0 — успех (в т.ч. ноль sl-контейнеров при непустых прочих);
2 — нет PORTAINER_API_KEY либо URL; 1 — сбой списка endpoints либо ни
одного контейнера не найдено.

Пример: mpu init --portainer https://portainer.example.com --dry-run`,
  policy: "rw",
  argsSchema,
  resultSchema,
  run: (args, io) => runInit(args, io),
  render: (result) => {
    const lines: string[] = [
      `# найдено sl-N контейнеров: ${result.containers.length}\n`,
    ];
    for (const c of result.containers) {
      lines.push(
        `sl-${c.serverNumber}: ${c.containerName} [${c.state}] @ endpoint ` +
          `${c.endpointId} (${c.endpointName}) -> ${result.portainerUrl}/${c.endpointId}\n`,
      );
    }
    lines.push(`# прочих контейнеров: ${result.otherCount}\n`);
    if (result.reset !== null) {
      lines.push(`# --reset: удалено ${result.reset.deleted} старых записей\n`);
    }
    if (result.write !== null) {
      lines.push(
        `# записано ${result.write.written} контейнеров в ${result.write.cacheDbPath}\n`,
      );
    }
    return lines.join("");
  },
});

/**
 * Шаги 1–2: bootstrap схемы и discovery контейнеров. Вынесено из
 * объявления команды по двум причинам: тело длиннее экрана, и пределы
 * одного HTTP-вызова здесь — параметр со значением по умолчанию.
 * Параметр нужен тесту молчащего endpoint'а: без него тест ждал бы
 * реальные три секунды продуктового предела, а сон стеной в тестах
 * запрещён (`ts/CLAUDE.md`). Команда зовёт эту функцию с умолчанием, то
 * есть вызова без таймаута по-прежнему не существует.
 */
export async function runInit(
  args: InitArgs,
  io: CommandIo,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<InitResult> {
  using db = io.openCacheDb();
  db.bootstrap();
  io.progress(`# bootstrap: схема в ${db.path} готова`);

  const access = requirePortainerAccess(args, io.envFile);

  let endpoints: readonly PortainerEndpoint[];
  try {
    endpoints = await listEndpoints(access, timeouts);
  } catch (err) {
    throw new DomainError(`portainer: ${reasonOf(err)}`, { cause: err });
  }

  const discoveredAt = Math.floor(Date.now() / 1000);
  const outcomes = await Promise.allSettled(
    endpoints.map((endpoint) => listContainers(access, endpoint.id, timeouts)),
  );

  const failures: EndpointFailure[] = [];
  const rows: ContainerRow[] = [];
  outcomes.forEach((outcome, index) => {
    const endpoint = endpoints[index];
    if (outcome.status === "rejected") {
      failures.push({
        id: endpoint.id,
        name: endpoint.name,
        reason: reasonOf(outcome.reason),
      });
      return;
    }
    for (const container of outcome.value) {
      const classified = classifyContainer(container.names);
      rows.push({
        portainerUrl: access.baseUrl,
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        containerId: container.id,
        containerName: classified.containerName,
        serverNumber: classified.serverNumber,
        state: container.state,
        image: container.image,
        discoveredAt,
      });
    }
  });

  // Порядок вывода детерминирован независимо от того, какой endpoint
  // ответил первым (конкурентность ненаблюдаема — инвариант спеки).
  for (const failure of failures.sort((a, b) => a.id - b.id)) {
    io.progress(
      `mpu init: endpoint ${failure.id} (${failure.name}): ${failure.reason}`,
    );
  }

  if (rows.length === 0) {
    throw new DomainError("ни одного контейнера не найдено");
  }

  const slRows = rows.filter(hasServerNumber).sort((a, b) =>
    a.serverNumber - b.serverNumber
  );

  let resetOutcome: { deleted: number } | null = null;
  let writeOutcome: { written: number; cacheDbPath: string } | null = null;
  if (!args["dry-run"]) {
    if (args.reset) {
      resetOutcome = {
        deleted: db.execute("DELETE FROM portainer_containers"),
      };
    }
    db.transaction(() => {
      for (const row of rows) {
        db.execute(
          UPSERT_CONTAINER_SQL,
          row.portainerUrl,
          row.endpointId,
          row.endpointName,
          row.containerId,
          row.containerName,
          row.serverNumber,
          row.state,
          row.image,
          row.discoveredAt,
        );
      }
    });
    writeOutcome = { written: rows.length, cacheDbPath: db.path };
  }

  return {
    portainerUrl: access.baseUrl,
    containers: slRows.map((row) => ({
      serverNumber: row.serverNumber,
      containerName: row.containerName,
      state: row.state,
      endpointId: row.endpointId,
      endpointName: row.endpointName,
    })),
    otherCount: rows.length - slRows.length,
    reset: resetOutcome,
    write: writeOutcome,
  };
}

/**
 * Читает и проверяет конфигурацию Portainer (`docs/specs/init.md`,
 * шаг 2). Тексты ошибок — дословно из спеки: путь `~/.config/mpu/.env`
 * в них литерал, а не вычисленный путь env-файла (см. проект
 * реализации порции А).
 */
function requirePortainerAccess(
  args: { readonly portainer?: string },
  envFile: { readonly get: (name: string) => string | undefined },
): PortainerAccess {
  const apiKey = envFile.get("PORTAINER_API_KEY");
  if (apiKey === undefined || apiKey === "") {
    throw new UsageError("в ~/.config/mpu/.env нет PORTAINER_API_KEY");
  }
  const rawUrl = args.portainer ?? envFile.get("PORTAINER_URL");
  if (rawUrl === undefined || rawUrl === "") {
    throw new UsageError(
      "укажите --portainer <url> либо PORTAINER_URL в ~/.config/mpu/.env",
    );
  }
  const verifyTls = envFile.get("PORTAINER_VERIFY_TLS") === "true";
  return { baseUrl: rawUrl.replace(/\/+$/, ""), apiKey, verifyTls };
}

/** Причина ошибки одной строкой (вердикт fix спеки — см. `portainer.ts`). */
function reasonOf(err: unknown): string {
  return firstLine(err instanceof Error ? err.message : String(err));
}
