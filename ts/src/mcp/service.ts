/**
 * Служба MCP-сервера в менеджере пользователя `systemd --user`
 * (`docs/specs/mcp-service.md`). Сервер живёт ровно столько, сколько
 * открыто окно, в котором его запустили; служба снимает это ограничение
 * и не меняет ни самого сервера, ни его конфигурации.
 *
 * Наружу модуль ходит двумя способами и только ими: файл описания в
 * каталоге служб пользователя и запуск `systemctl`/`loginctl`/`id`.
 * Запуск — шов (`RunProgram`): тесты подставляют менеджера, которого в
 * прогоне тестов нет.
 */

import { type CommandIo, DomainError } from "../command/mod.ts";
import { xdgConfigHome } from "../env/mod.ts";
import { installedBinPath } from "../install/mod.ts";

/** Исход запуска внешней программы. */
export interface ProgramOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Запуск внешней программы — единственный выход службы наружу. */
export type RunProgram = (
  bin: string,
  args: readonly string[],
) => Promise<ProgramOutcome>;

const decoder = new TextDecoder();

/**
 * Настоящий запуск: умолчание шва, а не подстановка вызывающего.
 * Отсутствие самой программы — не исход, а отказ: менеджера служб
 * пользователя на машине может не быть вовсе, и это отдельный ответ
 * (`mcp-service.md`, таблица случаев).
 */
export const spawnProgram: RunProgram = async (bin, args) => {
  const output = await new Deno.Command(bin, {
    args: [...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

/** Имя описания: служба одна на пользователя, как и порт. */
export const SERVICE_NAME = "mpu-mcp.service";

/** Каталог служб пользователя внутри каталога конфигурации XDG. */
export function serviceDir(configHome: string): string {
  return `${configHome}/systemd/user`;
}

/**
 * Описание службы. Аргумент программе один — `mcp`: порт и профили
 * берутся из конфигурации, и служба подхватывает их перезапуском, а не
 * переписыванием описания.
 *
 * @param program путь установленной программы для `ExecStart`
 */
export function unitText(program: string): string {
  return `[Unit]
Description=mpu MCP server over the command registry
Documentation=man:mpu(1)
After=default.target

[Service]
Type=simple
ExecStart=${program} mcp
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** Где живёт описание и чем говорить с менеджером. */
export interface ServiceDeps {
  /** Каталог служб пользователя. */
  readonly dir: string;
  /** Путь программы, который пойдёт в `ExecStart` при описании. */
  readonly program: string;
  readonly run: RunProgram;
}

/**
 * Подстановка менеджера службы и каталога описания. Умолчание — оба
 * настоящие; тесты подставляют своего менеджера, потому что в прогоне
 * тестов менеджера служб пользователя нет вовсе.
 */
export interface ServiceOptions {
  readonly deps?: ServiceDeps;
}

/**
 * Где искать описание и чем запускать службу — из окружения вызова.
 * Живёт здесь, а не у команд: потребителей два — семейство подкоманд и
 * голое `mpu mcp`, уступающее порт службе, — и второй лежит в модуле,
 * который семейство само же импортирует.
 */
export function serviceDeps(
  io: Pick<CommandIo, "env">,
  options: ServiceOptions = {},
): ServiceDeps {
  const deps = serviceDepsIfAny(io, options);
  if (deps !== undefined) return deps;
  throw new DomainError(
    "HOME не задана: ни каталог служб, ни путь установки не вычислить",
  );
}

/**
 * То же, но для того, кому нечего требовать: окружения без `HOME` не
 * бывает у службы, значит и службы в нём нет. Нужно голому `mpu mcp`:
 * оно уступает порт работающей службе, а её отсутствие — не отказ.
 */
export function serviceDepsIfAny(
  io: Pick<CommandIo, "env">,
  options: ServiceOptions = {},
): ServiceDeps | undefined {
  if (options.deps !== undefined) return options.deps;
  const home = io.env("HOME");
  const configHome = xdgConfigHome(io.env);
  if (home === undefined || home === "" || configHome === undefined) {
    return undefined;
  }
  return {
    dir: serviceDir(configHome),
    program: installedBinPath(home),
    run: spawnProgram,
  };
}

/**
 * Что известно о службе. «Службы нет» — не отсутствие состояния, а
 * состояние: `program` равен `null`, а активность и автозапуск ложны,
 * потому что менеджеру нечего о ней сказать.
 */
export interface ServiceState {
  /** Программа из `ExecStart` описания; описания нет — `null`. */
  readonly program: string | null;
  /** Ответ менеджера о состоянии; описания нет — `inactive`. */
  readonly activity: Activity;
  readonly enabled: boolean;
}

/** Значения задержки сеанса: один источник для типа и схемы результата. */
export const LINGER = ["on", "off", "unknown"] as const;

/**
 * Номер главного процесса службы у менеджера. Менеджер ответил отказом
 * или службы нет — `undefined`; менеджера нет вовсе — `DomainError`,
 * как у соседей по модулю.
 *
 * Нужен ровно одному вопросу: не мы ли и есть служба. Юнит запускает
 * тот же голый `mpu mcp`, и без этого вопроса запуск, которым служба
 * исполняется, останавливал бы её саму — то есть поверхность,
 * поднятая ради постоянной работы, не поднималась бы вовсе
 * (`docs/specs/mcp-service.md`, `[D.12]`; живой прогон 2026-09-09).
 *
 * Спрашивается у менеджера, а не берётся из окружения: новых прав не
 * требует. Цена — зависимость от того, когда менеджер номер
 * проставляет; для `Type=simple` он известен с момента порождения.
 */
export async function servicePid(
  deps: ServiceDeps,
): Promise<number | undefined> {
  const outcome = await systemctl(deps, [
    "show",
    SERVICE_NAME,
    "--property=MainPID",
    "--value",
  ]);
  if (outcome.code !== 0) return undefined;
  // `Number`, а не `parseInt`: последний принял бы «12abc» за 12, то
  // есть ответ не того формата сошёл бы за номер процесса.
  const pid = Number(outcome.stdout.trim());
  // Ноль — «главного процесса нет»: служба не работает.
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Задержка сеанса пользователя; `unknown` — `loginctl` не ответил. */
export type Linger = typeof LINGER[number];

/** Ответ `is-active`: состояние службы, а не строка транспорта. */
export type Activity =
  | "active"
  | "activating"
  | "deactivating"
  | "inactive"
  | "failed"
  | "unknown";

/**
 * Работает ли служба. `activating` — работает: с `Restart=on-failure`
 * занятый порт даёт цикл `active ↔ activating`, и `stop`, попавший в
 * окно перезапуска, обязан остановить её, а не отчитаться «уже
 * остановлена». `deactivating` — остановка уже идёт, второй `stop`
 * ничего не меняет.
 */
export function isRunning(activity: Activity): boolean {
  switch (activity) {
    case "active":
    case "activating":
      return true;
    case "deactivating":
    case "inactive":
    case "failed":
    case "unknown":
      return false;
    default: {
      const unknown: never = activity;
      throw new TypeError(`неизвестное состояние службы: ${String(unknown)}`);
    }
  }
}

/** Ответ менеджера — в состояние; чужое слово — `unknown`. */
function readActivity(answer: string): Activity {
  switch (answer) {
    case "active":
    case "activating":
    case "deactivating":
    case "inactive":
    case "failed":
      return answer;
    default:
      return "unknown";
  }
}

function unitPath(dir: string): string {
  return `${dir}/${SERVICE_NAME}`;
}

/**
 * Обращение к менеджеру. Ненулевой код здесь не отказ: `is-active` и
 * `is-enabled` отвечают им о состоянии, а не о сбое, — решает
 * вызывающий.
 */
async function systemctl(
  deps: ServiceDeps,
  args: readonly string[],
): Promise<ProgramOutcome> {
  try {
    return await deps.run("systemctl", ["--user", ...args]);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new DomainError(
        "менеджера служб пользователя нет: systemctl не найден",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Обращение, у которого ненулевой код — сбой: вывод менеджера наружу. */
async function mustSystemctl(
  deps: ServiceDeps,
  args: readonly string[],
): Promise<void> {
  const outcome = await systemctl(deps, args);
  if (outcome.code === 0) return;
  const said = `${outcome.stderr}${outcome.stdout}`.trim();
  // Подсказка про журнал — только там, где журнал службы уже есть:
  // у `daemon-reload` и `enable` смотреть в нём нечего.
  const started = args[0] === "start" || args[0] === "restart";
  const journal = started
    ? `\nжурнал: journalctl --user -u ${SERVICE_NAME} -n 50`
    : "";
  throw new DomainError(
    `systemctl --user ${args.join(" ")} завершился с ${outcome.code}` +
      `${said === "" ? "" : `: ${said}`}${journal}`,
  );
}

/** Программа из `ExecStart`; описания нет — `null`. */
async function describedProgram(dir: string): Promise<string | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(unitPath(dir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  const line = text.split("\n").find((row) => row.startsWith("ExecStart="));
  // Описание без `ExecStart` — не «службы нет»: файл лежит, и удалять
  // его `disable` обязан. Программа при этом неизвестна.
  return line === undefined
    ? ""
    : execStartProgram(line.slice("ExecStart=".length));
}

/**
 * Программа из значения `ExecStart`. Описание бывает написано не нами
 * (спека это допускает), а значение несёт модификаторы systemd
 * (`-`, `@`, `+`, `!`, `:`) и кавычки — и результат потом ЗАПУСКАЕТСЯ.
 * Первое слово как есть означало бы запуск пути с чужим префиксом.
 * Не разобралось — пусто: версия не получена, но ничего не запущено.
 */
function execStartProgram(value: string): string {
  const bare = value.trimStart().replace(/^[-@+!:]+/, "").trimStart();
  const quoted = bare.match(/^"((?:[^"\\]|\\.)*)"/);
  if (quoted !== null) return quoted[1].replace(/\\(.)/g, "$1");
  const word = bare.split(/\s/)[0];
  return word.includes('"') || word.includes("'") ? "" : word;
}

/**
 * Состояние службы. Источников два, и одним не обойтись: файл лежит и
 * при остановленной службе, а `is-enabled` на несуществующем описании
 * отвечает неотличимо от «выключена».
 */
export async function readServiceState(
  deps: ServiceDeps,
): Promise<ServiceState> {
  const program = await describedProgram(deps.dir);
  if (program === null) {
    return { program: null, activity: "inactive", enabled: false };
  }
  const [active, enabled] = await Promise.all([
    systemctl(deps, ["is-active", SERVICE_NAME]),
    systemctl(deps, ["is-enabled", SERVICE_NAME]),
  ]);
  return {
    program,
    activity: readActivity(active.stdout.trim()),
    enabled: enabled.stdout.trim() === "enabled",
  };
}

/** Итог `enable`: была ли служба уже поднята и что с ней теперь. */
export interface Enabled {
  readonly restarted: boolean;
  readonly state: ServiceState;
}

/**
 * Приводит описание к текущему виду — при любом исходном состоянии, —
 * перечитывает его менеджером, включает автозапуск и поднимает службу;
 * работающую перезапускает.
 *
 * Отвечает и о том, была ли служба поднята до вызова: состояние читается
 * здесь один раз, и вызывающему спрашивать второй раз незачем.
 */
export async function enableService(deps: ServiceDeps): Promise<Enabled> {
  const before = await readServiceState(deps);
  const described = before.program !== null;
  await writeUnit(deps);
  try {
    // Первое же обращение к менеджеру — оно же проверка того, что
    // менеджер есть: спека требует, чтобы при его отсутствии не
    // создалось ничего.
    await mustSystemctl(deps, ["daemon-reload"]);
  } catch (err) {
    // Убрать не удалось — наружу всё равно уходит отказ менеджера: он
    // и есть причина, а второй отказ поверх него скрыл бы первый.
    if (!described) await removeUnit(deps).catch(() => {});
    throw err;
  }
  await mustSystemctl(deps, ["enable", SERVICE_NAME]);
  const restarted = isRunning(before.activity);
  await mustSystemctl(deps, [restarted ? "restart" : "start", SERVICE_NAME]);
  return { restarted, state: await readServiceState(deps) };
}

async function writeUnit(deps: ServiceDeps): Promise<void> {
  try {
    await Deno.mkdir(deps.dir, { recursive: true });
    await Deno.writeTextFile(unitPath(deps.dir), unitText(deps.program));
  } catch (err) {
    if (err instanceof Deno.errors.PermissionDenied) {
      throw new DomainError(
        `каталог служб недоступен на запись: ${deps.dir}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Останавливает, снимает с автозапуска и удаляет описание. Отвечает,
 * было ли что снимать: описания нет — ничего не меняется.
 *
 * Файл удаляется обязательно: оставленный, он заставил бы `start`
 * работать после `disable`.
 */
export async function disableService(deps: ServiceDeps): Promise<boolean> {
  const state = await readServiceState(deps);
  if (state.program === null) return false;
  if (isRunning(state.activity)) {
    await mustSystemctl(deps, ["stop", SERVICE_NAME]);
  }
  if (state.enabled) await mustSystemctl(deps, ["disable", SERVICE_NAME]);
  await removeUnit(deps);
  await mustSystemctl(deps, ["daemon-reload"]);
  return true;
}

/** Удаление описания. Файла уже нет — цель достигнута, а не отказ. */
async function removeUnit(deps: ServiceDeps): Promise<void> {
  try {
    await Deno.remove(unitPath(deps.dir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    if (err instanceof Deno.errors.PermissionDenied) {
      throw new DomainError(`каталог служб недоступен на запись: ${deps.dir}`, {
        cause: err,
      });
    }
    throw err;
  }
}

/** Итог переключателя: изменилось ли что-нибудь и что теперь. */
export interface Switched {
  readonly changed: boolean;
  readonly state: ServiceState;
}

/** Запускает описанную службу. Работающую не трогает. */
export async function startService(deps: ServiceDeps): Promise<Switched> {
  const state = await requireDescribed(deps, "запускать");
  if (isRunning(state.activity)) return { changed: false, state };
  await mustSystemctl(deps, ["start", SERVICE_NAME]);
  return { changed: true, state: await readServiceState(deps) };
}

/** Останавливает описанную службу. Остановленную не трогает. */
export async function stopService(deps: ServiceDeps): Promise<Switched> {
  const state = await requireDescribed(deps, "останавливать");
  if (!isRunning(state.activity)) return { changed: false, state };
  await mustSystemctl(deps, ["stop", SERVICE_NAME]);
  return { changed: true, state: await readServiceState(deps) };
}

/** Итог `restart`: работала ли служба до вызова и что с ней теперь. */
export interface Restarted {
  readonly wasRunning: boolean;
  readonly state: ServiceState;
}

/**
 * Перезапускает описанную службу — ОДНИМ обращением к менеджеру, а не
 * парой «остановить, затем запустить»: пара оставила бы службу лежащей,
 * не удайся второе обращение, а команда, называющаяся перезапуском,
 * обязана кончиться либо работающей службой, либо названным отказом.
 *
 * Остановленную поднимает: `restart` у менеджера значит именно это.
 */
export async function restartService(deps: ServiceDeps): Promise<Restarted> {
  const before = await requireDescribed(deps, "перезапускать");
  await mustSystemctl(deps, ["restart", SERVICE_NAME]);
  return {
    wasRunning: isRunning(before.activity),
    state: await readServiceState(deps),
  };
}

/**
 * Перезапускает службу, если она работает: после замены программы в
 * памяти оставался бы прежний экземпляр, и ответ службы расходился бы с
 * ответом терминала. Отвечает, был ли перезапуск.
 *
 * Решение «перезапускать или нет» принимает служба, а не сборка:
 * `mpu build` спрашивает, а не читает состояние, чтобы решить самому.
 */
export async function restartIfRunning(deps: ServiceDeps): Promise<boolean> {
  const state = await readServiceState(deps);
  if (state.program === null || !isRunning(state.activity)) return false;
  await mustSystemctl(deps, ["restart", SERVICE_NAME]);
  return true;
}

async function requireDescribed(
  deps: ServiceDeps,
  what: "запускать" | "останавливать" | "перезапускать",
): Promise<ServiceState> {
  const state = await readServiceState(deps);
  if (state.program !== null) return state;
  throw new DomainError(
    `службы нет — ${what} нечего; поставь \`mpu mcp enable\``,
  );
}

/**
 * Задержка сеанса пользователя. Имя берётся числовым идентификатором:
 * `loginctl` без имени отвечает про менеджера, а не про пользователя, а
 * переменная `USER` у бинаря запрещена правом `--deny-env`.
 */
export async function sessionLinger(run: RunProgram): Promise<Linger> {
  const outcome = await ask(run, "id", ["-u"]);
  const uid = outcome?.code === 0 ? outcome.stdout.trim() : "";
  if (uid === "") return "unknown";
  const linger = await ask(run, "loginctl", [
    "show-user",
    uid,
    "--property=Linger",
    "--value",
  ]);
  if (linger === undefined || linger.code !== 0) return "unknown";
  const value = linger.stdout.trim();
  if (value === "yes") return "on";
  return value === "no" ? "off" : "unknown";
}

/**
 * Версия программы, указанной в описании, — не работающей копии: они
 * расходятся ровно между `mpu build` и перезапуском службы, и увидеть
 * это расхождение — половина смысла `mpu mcp status`. Не ответила —
 * `null`: версии нет, а отказывать команде состояния не за что.
 */
export async function programVersion(
  program: string,
  run: RunProgram,
): Promise<string | null> {
  const outcome = await ask(run, program, ["version"]);
  if (outcome === undefined || outcome.code !== 0) return null;
  const version = outcome.stdout.trim();
  return version === "" ? null : version;
}

/**
 * Запуск, у которого невозможность породить процесс — такой же ответ,
 * как ненулевой код. Спрашиваем этим и о чужом описании: `ExecStart`
 * может указывать на каталог или на неисполняемый файл, и падать трассой
 * команде состояния не за что — «версия не получена» и есть ответ.
 */
async function ask(
  run: RunProgram,
  bin: string,
  args: readonly string[],
): Promise<ProgramOutcome | undefined> {
  try {
    return await run(bin, args);
  } catch (err) {
    return err instanceof Deno.errors.NotFound ||
        err instanceof Deno.errors.PermissionDenied ||
        err instanceof Deno.errors.NotCapable ||
        err instanceof Deno.errors.IsADirectory
      ? undefined
      : Promise.reject(err);
  }
}
