/**
 * Семейство `mpu mcp status | enable | disable | start | stop`
 * (`docs/specs/mcp-service.md`): служба MCP-сервера в менеджере
 * пользователя. Подкоманды — обычные листья группы `mcp`, поэтому
 * голое `mpu mcp` (сервер на переднем плане) остаётся прежним:
 * подкоманду называет только первый аргумент, а флаг уходит в него.
 *
 * Токен не печатает ни одна из пяти: место у него одно — `mpu mcp
 * token` (инвариант `platform/mcp-server.md`).
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, DomainError } from "../command/mod.ts";
import { xdgConfigHome } from "../env/mod.ts";
import { installedBinPath } from "../install/mod.ts";
import { configuredPort, DEFAULT_PROFILES } from "./cli.ts";
import { LOOPBACK } from "./server.ts";
import {
  disableService,
  enableService,
  isRunning,
  LINGER,
  type Linger,
  programVersion,
  readServiceState,
  restartIfRunning,
  SERVICE_NAME,
  type ServiceDeps,
  serviceDir,
  sessionLinger,
  spawnProgram,
  startService,
  stopService,
} from "./service.ts";

/**
 * Подстановка менеджера службы и каталога описания. Умолчание — оба
 * настоящие; тесты подставляют своего менеджера, потому что в прогоне
 * тестов менеджера служб пользователя нет вовсе.
 */
export interface ServiceOptions {
  readonly deps?: ServiceDeps;
}

/** Где искать описание и чем запускать службу — из окружения вызова. */
function serviceDeps(io: CommandIo, options: ServiceOptions): ServiceDeps {
  if (options.deps !== undefined) return options.deps;
  const home = io.env("HOME");
  const configHome = xdgConfigHome(io.env);
  if (home === undefined || home === "" || configHome === undefined) {
    throw new DomainError(
      "HOME не задана: ни каталог служб, ни путь установки не вычислить",
    );
  }
  return {
    dir: serviceDir(configHome),
    program: installedBinPath(home),
    run: spawnProgram,
  };
}

/** Адрес и профили сервера — из конфигурации, не из описания службы. */
function endpoint(io: CommandIo): {
  readonly address: string;
  readonly profiles: string[];
} {
  return {
    address: `http://${LOOPBACK}:${configuredPort(io)}`,
    profiles: DEFAULT_PROFILES.map((profile) => `/${profile}`),
  };
}

const lingerSchema = z.enum(LINGER).describe(
  "задержка сеанса: переживает ли служба выход пользователя из системы",
);

/** Строка о задержке сеанса: `enable` и `status` печатают одну и ту же. */
function lingerLine(linger: Linger): string {
  if (linger === "on") return "задержка сеанса: включена\n";
  if (linger === "off") {
    return "задержка сеанса: выключена — служба остановится при выходе " +
      "из системы (включается `loginctl enable-linger`, права свои)\n";
  }
  return "задержка сеанса: неизвестна — loginctl не ответил\n";
}

function endpointLine(address: string, profiles: readonly string[]): string {
  return `адрес: ${address} (${profiles.join(", ")})\n`;
}

const statusSchema = z.object({
  installed: z.boolean().describe("описание службы существует"),
  active: z.boolean().describe("служба работает"),
  enabled: z.boolean().describe("автозапуск включён"),
  program: z.string().nullable().describe(
    "программа из ExecStart описания; null — описания нет",
  ),
  version: z.string().nullable().describe(
    "версия этой программы; null — не ответила",
  ),
  address: z.string().describe("адрес сервера из конфигурации"),
  profiles: z.array(z.string()).describe("профили сервера"),
  linger: lingerSchema,
});

/** Снимок службы: описание, состояние у менеджера, адрес и версия. */
export async function runStatus(
  io: CommandIo,
  options: ServiceOptions = {},
): Promise<z.infer<typeof statusSchema>> {
  const deps = serviceDeps(io, options);
  const state = await readServiceState(deps);
  const { address, profiles } = endpoint(io);
  return {
    installed: state.program !== null,
    active: isRunning(state.activity),
    enabled: state.enabled,
    program: state.program,
    // Версию спрашиваем у программы из описания, а не у работающей
    // копии: их расхождение и есть то, что показывает эта команда.
    version: state.program === null || state.program === ""
      ? null
      : await programVersion(state.program, deps.run),
    address,
    profiles,
    linger: await sessionLinger(deps.run),
  };
}

export const mcpStatusCommand = defineCommand({
  path: ["mcp", "status"],
  summary: "состояние службы MCP-сервера: описание, автозапуск, версия",
  usage: "mpu mcp status",
  help: `Печатает всё, что известно о службе \`${SERVICE_NAME}\` менеджера
пользователя, и ничего не меняет.

Версию показывает та программа, что указана в описании службы, а не
работающая копия: они расходятся ровно между \`mpu build\` и
перезапуском службы, и увидеть это расхождение — половина смысла
команды.

Отсутствие службы — такой же ответ, как её наличие: на машине без
службы печатается «не установлена» и код возврата 0.

Токен доступа не печатается — его печатает только \`mpu mcp token\`.

Exit: 0 — состояние прочитано, в том числе «службы нет»; 1 — описание
есть, а менеджер не ответил.

Пример: mpu mcp status`,
  errorName: "mcp status",
  policy: "ro",
  argsSchema: z.object({}),
  resultSchema: statusSchema,
  run: (_args, io) => runStatus(io),
  render: (result) => {
    if (!result.installed) {
      return `служба ${SERVICE_NAME}: не установлена ` +
        "(`mpu mcp enable` — описать и запустить)\n";
    }
    const running = result.active ? "работает" : "остановлена";
    const auto = result.enabled ? "включён" : "выключен";
    const version = result.version ?? "версия не получена";
    const program = result.program === "" || result.program === null
      ? "в описании нет ExecStart"
      : `${result.program} (${version})`;
    return `служба ${SERVICE_NAME}: ${running}, автозапуск ${auto}\n` +
      `программа: ${program}\n` +
      endpointLine(result.address, result.profiles) +
      lingerLine(result.linger);
  },
});

const enableSchema = z.object({
  path: z.string().describe("путь файла описания службы"),
  restarted: z.boolean().describe("служба была перезапущена, а не поднята"),
  active: z.boolean().describe("служба работает после вызова"),
  address: z.string().describe("адрес сервера из конфигурации"),
  profiles: z.array(z.string()).describe("профили сервера"),
  linger: lingerSchema,
});

/** Описать службу, включить автозапуск и поднять её. */
export async function runEnable(
  io: CommandIo,
  options: ServiceOptions = {},
): Promise<z.infer<typeof enableSchema>> {
  const deps = serviceDeps(io, options);
  const enabled = await enableService(deps);
  const { address, profiles } = endpoint(io);
  return {
    path: `${deps.dir}/${SERVICE_NAME}`,
    restarted: enabled.restarted,
    active: isRunning(enabled.state.activity),
    address,
    profiles,
    linger: await sessionLinger(deps.run),
  };
}

export const mcpEnableCommand = defineCommand({
  path: ["mcp", "enable"],
  summary: "описать службу MCP-сервера, запустить и включить в автозапуск",
  usage: "mpu mcp enable",
  help: `Приводит описание \`${SERVICE_NAME}\` к текущему виду и делает это
всегда: описания нет, оно отстало, испорчено или написано не нами —
итог один. Затем перечитывает описание менеджером, включает автозапуск
и поднимает службу; работающую — перезапускает.

\`ExecStart\` — путь установки (~/.local/bin/mpu), а не путь текущей
программы: служба обязана следовать за установкой, а не приколачиваться
к сегодняшнему файлу. Аргумент службе один — \`mcp\`: порт и профили
берутся из конфигурации и подхватываются перезапуском.

Задержку сеанса команда не включает — она требует прав, которых может
не быть; о её отсутствии печатается строка.

Токен доступа не печатается — его печатает только \`mpu mcp token\`.

Exit: 0 — служба описана и работает; 1 — менеджер отказал.

Пример: mpu mcp enable`,
  errorName: "mcp enable",
  policy: "rw",
  argsSchema: z.object({}),
  resultSchema: enableSchema,
  run: (_args, io) => runEnable(io),
  render: (result) => {
    const what = result.restarted ? "перезапущена" : "описана и запущена";
    const head = result.active
      ? `служба ${SERVICE_NAME}: ${what}\n`
      : `служба ${SERVICE_NAME}: ${what}, но не работает — ` +
        `journalctl --user -u ${SERVICE_NAME} -n 50\n`;
    return head +
      `описание: ${result.path}\n` +
      endpointLine(result.address, result.profiles) +
      "заголовок авторизации: `mpu mcp token`\n" +
      lingerLine(result.linger);
  },
  // `systemctl start` при `Type=simple` отвечает нулём раньше, чем
  // процесс успевает упасть на занятом порту. Код возврата берётся с
  // состояния службы, а не с ответа менеджера.
  textExitCode: (result) => result.active ? 0 : 1,
});

const disableSchema = z.object({
  removed: z.boolean().describe("описание было и удалено"),
  path: z.string().describe("путь файла описания службы"),
});

/** Остановить, снять с автозапуска и удалить описание. */
export async function runDisable(
  io: CommandIo,
  options: ServiceOptions = {},
): Promise<z.infer<typeof disableSchema>> {
  const deps = serviceDeps(io, options);
  return {
    removed: await disableService(deps),
    path: `${deps.dir}/${SERVICE_NAME}`,
  };
}

export const mcpDisableCommand = defineCommand({
  path: ["mcp", "disable"],
  summary: "остановить службу, снять с автозапуска и удалить описание",
  usage: "mpu mcp disable",
  help: `Останавливает \`${SERVICE_NAME}\`, снимает с автозапуска и удаляет
описание. Файл удаляется обязательно: оставленный, он заставил бы
\`mpu mcp start\` работать после \`disable\`, и «выключено насовсем»
выразить стало бы нечем.

Описания нет — ничего не меняется, код возврата 0.

Exit: 0 — описания больше нет; 1 — менеджер отказал.

Пример: mpu mcp disable`,
  errorName: "mcp disable",
  policy: "rw",
  argsSchema: z.object({}),
  resultSchema: disableSchema,
  run: (_args, io) => runDisable(io),
  render: (result) =>
    result.removed
      ? `служба ${SERVICE_NAME}: остановлена, снята с автозапуска, ` +
        `описание удалено (${result.path})\n`
      : `служба ${SERVICE_NAME}: описания нет — менять нечего\n`,
});

/**
 * Итог `start`: сказанное менеджеру и то, что вышло. Расходятся они на
 * занятом порту — тогда и печатается, где смотреть журнал.
 */
function startStopLine(
  result: { readonly changed: boolean; readonly active: boolean },
  changed: string,
  same: string,
): string {
  if (!result.active) {
    return `служба ${SERVICE_NAME}: не работает — ` +
      `journalctl --user -u ${SERVICE_NAME} -n 50\n`;
  }
  return `служба ${SERVICE_NAME}: ${result.changed ? changed : same}\n`;
}

const switchSchema = z.object({
  changed: z.boolean().describe("состояние службы изменилось этим вызовом"),
  active: z.boolean().describe("служба работает после вызова"),
});

/** Запустить описанную службу. */
export async function runStart(
  io: CommandIo,
  options: ServiceOptions = {},
): Promise<z.infer<typeof switchSchema>> {
  const switched = await startService(serviceDeps(io, options));
  return {
    changed: switched.changed,
    active: isRunning(switched.state.activity),
  };
}

export const mcpStartCommand = defineCommand({
  path: ["mcp", "start"],
  summary: "запустить описанную службу MCP-сервера",
  usage: "mpu mcp start",
  help: `Запускает уже описанную службу \`${SERVICE_NAME}\`. Работающую не
трогает: повторный вызов оставляет ту же картину.

Описания не заводит: описания нет — отказ с именем команды, которая его
создаёт (\`mpu mcp enable\`). Иначе первый же \`start\` воскрешал бы
службу, выключенную \`disable\`.

Exit: 0 — служба работает; 1 — описания нет либо менеджер отказал.

Пример: mpu mcp start`,
  errorName: "mcp start",
  policy: "rw",
  argsSchema: z.object({}),
  resultSchema: switchSchema,
  run: (_args, io) => runStart(io),
  render: (result) => startStopLine(result, "запущена", "уже работает"),
  // Та же причина, что у `enable`: `systemctl start` при `Type=simple`
  // отвечает нулём раньше, чем процесс успевает упасть на занятом порту.
  textExitCode: (result) => result.active ? 0 : 1,
});

/** Остановить описанную службу, не снимая с автозапуска. */
export async function runStop(
  io: CommandIo,
  options: ServiceOptions = {},
): Promise<z.infer<typeof switchSchema>> {
  const switched = await stopService(serviceDeps(io, options));
  return {
    changed: switched.changed,
    active: isRunning(switched.state.activity),
  };
}

export const mcpStopCommand = defineCommand({
  path: ["mcp", "stop"],
  summary: "остановить службу MCP-сервера, не снимая с автозапуска",
  usage: "mpu mcp stop",
  help: `Останавливает службу \`${SERVICE_NAME}\`, оставляя описание и
автозапуск на месте. Остановленную не трогает: повторный вызов
оставляет ту же картину.

Описания нет — отказ с именем команды, которая его создаёт
(\`mpu mcp enable\`).

Exit: 0 — служба остановлена; 1 — описания нет либо менеджер отказал.

Пример: mpu mcp stop`,
  errorName: "mcp stop",
  policy: "rw",
  argsSchema: z.object({}),
  resultSchema: switchSchema,
  run: (_args, io) => runStop(io),
  render: (result) =>
    result.changed
      ? `служба ${SERVICE_NAME}: остановлена\n`
      : `служба ${SERVICE_NAME}: уже остановлена\n`,
});

/** Все пять подкоманд службы в порядке показа в справке. */
export const mcpServiceCommands = [
  mcpStatusCommand,
  mcpEnableCommand,
  mcpDisableCommand,
  mcpStartCommand,
  mcpStopCommand,
];

/**
 * «Перезапустись, если работаешь» — то, что спрашивает у службы
 * `mpu build` после замены программы. Состояние службы наружу не
 * отдаётся: решает она, а не сборка.
 *
 * Отказ приходит исходом, а не исключением: спрашивают об этом после
 * того, как программа уже заменена, и брошенная наружу ошибка спрятала
 * бы состоявшуюся установку (`docs/specs/build.md`, «Служба не
 * перезапустилась»). Текст отказа собирается здесь, пока ошибка жива;
 * назвать команду в нём нечем — строку печатает `mpu build`, и она уже
 * подписана им.
 */
export async function restartServiceIfRunning(
  io: CommandIo,
  options: ServiceOptions = {},
): Promise<
  | { readonly kind: "restarted" }
  | { readonly kind: "untouched" }
  | { readonly kind: "restart-failed"; readonly reason: string }
> {
  try {
    return await restartIfRunning(serviceDeps(io, options))
      ? { kind: "restarted" }
      : { kind: "untouched" };
  } catch (err) {
    return { kind: "restart-failed", reason: refusalText(err) };
  }
}

/** Причина отказа текстом. Не-`Error` бывает у чужой реализации шва. */
function refusalText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : Deno.inspect(err);
}
