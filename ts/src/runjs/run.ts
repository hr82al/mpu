/**
 * Ход вызова `mpu run-js` (`specs/run-js.md`): источник кода, таргеты,
 * четыре режима (превью, последовательный, параллельный, фоновый) и
 * код выхода. Печати здесь нет: вывод удалённых команд уходит приёмником
 * io, служебные строки — портом диагностики.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  NotFoundIoError,
  readTextStdin,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import { copyToClipboard } from "../clipboard/mod.ts";
import {
  chooseTransport,
  detachOverPortainer,
  detachOverSsh,
  type ExecTarget,
  type HttpCall,
  type OpenChannel,
  runOverPortainer,
  runOverSsh,
  type RunProcess,
  viaOf,
} from "../exec/mod.ts";
import type { CacheReader } from "../selector/mod.ts";
import { previewOf } from "./preview.ts";
import { type Scope, type Target, targetsOf } from "./targets.ts";

/** Ключ ssh — без настройки (`platform/exec-transport.md`). */
const KEY_FILE = ".ssh/id_rsa";

/** Команда, которой скармливается код (`specs/run-js.md`, «Назначение»). */
export const NODE_COMMAND: readonly [string, ...string[]] = [
  "node",
  "--input-type=module",
  "-",
];

/** Порт исполнения глазами команды. */
export type RunJsIo = Pick<
  CommandIo,
  | "env"
  | "envFile"
  | "openCacheDb"
  | "openRemoteOutput"
  | "progress"
  | "readTextFile"
  | "readStdin"
  | "stdinIsTerminal"
>;

export const argsSchema = z.object({
  selector: z.string().optional().describe(
    "sl-N, dev:N, точное имя контейнера, client_id/spreadsheet/title;" +
      " с --all и --all-containers селектора нет",
  ),
  code: z.string().optional().describe("ESM-код; иначе --file или stdin"),
  file: z.string().optional().describe("файл с ESM-кодом"),
  all: z.boolean().default(false).describe(
    "все инстанс-серверы кэша (sl-N, N>0)",
  ),
  "all-containers": z.string().optional().describe(
    "контейнеры кэша, чьё имя содержит подстроку",
  ),
  "dry-run": z.boolean().default(false).describe(
    "напечатать команду и скопировать её в буфер обмена, не выполняя",
  ),
  via: z.string().optional().describe(
    "транспорт серверного таргета: ssh|portainer",
  ),
  parallel: z.boolean().default(false).describe(
    "все таргеты одновременно; вывод по каждому — по его завершении",
  ),
  jobs: z.number().default(0).describe(
    "предел одновременных таргетов при --parallel; 0 — все",
  ),
  detach: z.boolean().default(false).describe(
    "фоновый запуск: скрипт заливается в контейнер, лог остаётся в /tmp",
  ),
});

/** Итог по одному таргету. */
const targetResultSchema = z.object({
  label: z.string(),
  /** Код удалённой команды либо код запуска у `--detach`. */
  exitCode: z.number().int().nullable(),
  /** Причина, если таргет не дошёл до кода выхода. */
  failure: z.string().nullable(),
});

export const resultSchema = z.object({
  mode: z.enum(["dry-run", "sequential", "parallel", "detach"]),
  targets: z.array(targetResultSchema).readonly(),
  /** Идентификатор фонового запуска и путь лога; иначе null. */
  detach: z.object({ id: z.string(), log: z.string() }).nullable(),
  /** Текст блока `--dry-run`: его печатает рендер. */
  preview: z.string(),
  /** Вывод удалённых команд, если приёмник копил (вызов тула). */
  output: z.string(),
  /** Код выхода вызова целиком. */
  exitCode: z.number().int(),
});

export type RunJsArgs = z.infer<typeof argsSchema>;
export type RunJsResult = z.infer<typeof resultSchema>;
type TargetResult = z.infer<typeof targetResultSchema>;

/** Подстановки транспорта и буфера: живого контейнера в тестах нет. */
export interface RunJsOptions {
  readonly runProcess?: RunProcess;
  readonly openChannel?: OpenChannel;
  readonly httpCall?: HttpCall;
  readonly copy?: (text: string) => Promise<boolean>;
  readonly newDetachId?: () => string;
}

/** Исполняет вызов и возвращает его итог. */
export async function runRunJs(
  args: RunJsArgs,
  io: RunJsIo,
  options: RunJsOptions = {},
): Promise<RunJsResult> {
  // Значение `--via` проверяется при разборе ввода, до любого вывода
  // (спека, отклонение `fix`): иначе отказу предшествовали бы служебные
  // строки уже начатого обхода.
  const via = viaOf(args.via);
  // Значение `--jobs` — тоже ввод: проверяется здесь, а не в режиме,
  // куда вызов может и не дойти (один таргет идёт последовательно).
  const jobs = jobsOf(args.jobs);
  const scope = scopeOf(args);
  const code = await codeOf(args, io);

  let db: CacheDb | undefined;
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  try {
    const found = targetsOf(scope, { cache, env: io.envFile });
    if (args["dry-run"]) return preview(found, code, options);
    // Транспорт выбирается всем таргетам до первой служебной строки:
    // нехватка конфигурации и `--via ssh` с контейнером — ошибки ввода
    // (exit 2), и всплыть посреди обхода они не должны, иначе агрегация
    // сбоев подменила бы код выхода (спека, отклонения `fix`).
    const targets = found.map((target) => ({
      ...target,
      transport: chooseTransport({
        place: target.place,
        env: io.envFile,
        cache,
        via,
      }),
    }));
    const output = io.openRemoteOutput();
    const call: Call = { args, io, options, code, jobs, output };
    io.progress(
      `# mpu run-js: targets = [${targets.map((t) => t.label).join(", ")}]`,
    );
    if (args.detach) return await detachAll(targets, call);
    if (args.parallel && targets.length > 1) {
      return await parallel(targets, call);
    }
    return await sequential(targets, call);
  } finally {
    db?.[Symbol.dispose]();
  }
}

/** Таргет вместе с выбранным ему транспортом. */
interface Ready extends Target {
  readonly transport: ExecTarget;
}

/** Всё, что нужно любому режиму; собирается один раз на вызов. */
interface Call {
  readonly args: RunJsArgs;
  readonly io: RunJsIo;
  readonly options: RunJsOptions;
  readonly code: string;
  /** Предел одновременных таргетов; 0 — все. */
  readonly jobs: number;
  readonly output: RemoteOutput;
}

/**
 * `--dry-run`: печатается команда, которой ушёл бы код, и копируется в
 * буфер обмена. Ни сети, ни выполнения; отказ копирования ни вывода, ни
 * кода выхода не меняет (спека).
 */
async function preview(
  targets: readonly Target[],
  code: string,
  options: RunJsOptions,
): Promise<RunJsResult> {
  const text = previewOf(targets.map((target) => target.label), code);
  const copy = options.copy ?? copyToClipboard;
  await copy(text);
  return {
    mode: "dry-run",
    targets: targets.map((target) => idle(target.label)),
    detach: null,
    preview: text,
    output: "",
    exitCode: 0,
  };
}

/** Последовательный режим: первый ненулевой код прерывает остальные. */
async function sequential(
  targets: readonly Ready[],
  call: Call,
): Promise<RunJsResult> {
  const done: TargetResult[] = [];
  for (const target of targets) {
    call.io.progress(`# target=${target.label}`);
    const exitCode = await execute(target.transport, call, call.output);
    done.push({ label: target.label, exitCode, failure: null });
    if (exitCode !== 0) {
      call.io.progress(
        `mpu run-js: ${target.label} exit=${exitCode} — abort`,
      );
      return finish("sequential", done, targets, call, exitCode);
    }
  }
  return finish("sequential", done, targets, call, 0);
}

/**
 * `--parallel`: таргеты идут одновременно, вывод каждого копится и
 * печатается по его завершении — иначе строки разных контейнеров
 * перемешались бы в одном потоке.
 */
async function parallel(
  targets: readonly Ready[],
  call: Call,
): Promise<RunJsResult> {
  const limit = jobsOf(call.args.jobs);
  const workers = limit === 0
    ? targets.length
    : Math.min(limit, targets.length);
  call.io.progress(
    `# mpu run-js: parallel — ${targets.length} targets, ${workers} workers;` +
      " вывод по каждому таргету печатается по его завершении",
  );
  const done: TargetResult[] = [];
  const queue = [...targets];
  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (target === undefined) return;
      const buffered = buffer();
      const result = await attempt(target, call, buffered);
      buffered.flush(call.output);
      done.push(result);
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  const failed = done.filter((result) => result.exitCode !== 0);
  if (failed.length > 0) {
    call.io.progress(
      `mpu run-js: failures on [${failed.map((r) => r.label).join(", ")}]`,
    );
  }
  return finish("parallel", done, targets, call, failed.length > 0 ? 1 : 0);
}

/**
 * `--detach`: один идентификатор на весь вызов, поэтому пути скрипта и
 * лога совпадают на всех таргетах. Сбой одного таргета остальных не
 * прерывает — запуск и так неблокирующий.
 */
async function detachAll(
  targets: readonly Ready[],
  call: Call,
): Promise<RunJsResult> {
  const id = (call.options.newDetachId ?? randomDetachId)();
  const script = `/tmp/mpu-run-${id}.mjs`;
  const log = `/tmp/mpu-run-${id}.log`;
  call.io.progress(
    `# mpu run-js: detached run_id=${id} — лог на каждом сервере: ${log}`,
  );
  const done: TargetResult[] = [];
  for (const target of targets) {
    done.push(await detachOne(target, call, script, log));
  }
  hints(targets, call, log);
  const failed = done.filter((result) => result.exitCode !== 0);
  if (failed.length > 0) {
    call.io.progress(
      `mpu run-js: detach failures on [${
        failed.map((r) => r.label).join(", ")
      }]`,
    );
  }
  return {
    ...finish("detach", done, targets, call, failed.length > 0 ? 1 : 0),
    detach: { id, log },
  };
}

async function detachOne(
  target: Ready,
  call: Call,
  script: string,
  log: string,
): Promise<TargetResult> {
  try {
    const exitCode = await launch(target.transport, call, script, log);
    call.io.progress(
      exitCode === 0
        ? `# ${target.label}: started → ${log}`
        : `# ${target.label}: launch exit=${exitCode}`,
    );
    return { label: target.label, exitCode, failure: null };
  } catch (err) {
    // Сбой одного таргета не прерывает остальных (спека): причина
    // называется строкой и учитывается в итоговом коде выхода.
    const reason = err instanceof Error ? err.message : String(err);
    call.io.progress(`# ${target.label}: detach FAILED — ${reason}`);
    return { label: target.label, exitCode: null, failure: reason };
  }
}

/** Подсказки, как забрать логи; только когда среди таргетов есть серверные. */
function hints(
  targets: readonly Ready[],
  call: Call,
  log: string,
): void {
  const servers = targets.filter((target) => target.place.kind !== "container");
  if (servers.length === 0) return;
  const scope = servers.length > 1 ? "--all" : servers[0].label;
  call.io.progress(`# собрать логи: mpu run-js ${scope} '${reader(log)}'`);
  call.io.progress(
    `# или вживую: mpu ssh ${servers[0].label} -- tail -f ${log}`,
  );
}

/**
 * Читалка лога — дословно из спеки, в одну строку: пробела после
 * запятой в `readFileSync` нет, `\n` — два символа исходника.
 */
function reader(log: string): string {
  return `import fs from "node:fs"; process.stdout.write(` +
    `fs.existsSync("${log}") ? fs.readFileSync("${log}","utf8")` +
    ` : "no log yet\\n")`;
}

/**
 * Один таргет `--parallel`: сбой изолируется — остальные обходятся, а
 * причина учитывается в итоговом коде выхода (спека, «Ввод/вывод»).
 */
async function attempt(
  target: Ready,
  call: Call,
  buffered: { readonly sink: RemoteOutput },
): Promise<TargetResult> {
  try {
    const exitCode = await execute(target.transport, call, buffered.sink);
    call.io.progress(`# ===== ${target.label} (exit=${exitCode}) =====`);
    return { label: target.label, exitCode, failure: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    call.io.progress(`# ===== ${target.label} (FAILED — ${reason}) =====`);
    return { label: target.label, exitCode: null, failure: reason };
  }
}

/** Прогон одного таргета готовым транспортом. */
function execute(
  target: ExecTarget,
  call: Call,
  output: RemoteOutput,
): Promise<number> {
  const stdin = new TextEncoder().encode(call.code);
  return target.kind === "ssh"
    ? runOverSsh({
      target,
      command: NODE_COMMAND,
      stdin,
      keyPath: keyPath(call.io),
      output,
      run: call.options.runProcess,
    })
    : runOverPortainer({
      target,
      command: NODE_COMMAND,
      stdin,
      output,
      warn: call.io.progress,
      http: call.options.httpCall,
      open: call.options.openChannel,
    });
}

/** Фоновый запуск одного таргета. */
function launch(
  target: ExecTarget,
  call: Call,
  script: string,
  log: string,
): Promise<number> {
  return target.kind === "ssh"
    ? detachOverSsh({
      target,
      script: call.code,
      scriptPath: script,
      logPath: log,
      keyPath: keyPath(call.io),
      output: call.output,
      run: call.options.runProcess,
    })
    : detachOverPortainer({
      target,
      script: call.code,
      scriptPath: script,
      logPath: log,
      output: call.output,
      warn: call.io.progress,
      http: call.options.httpCall,
      open: call.options.openChannel,
    });
}

/** Итог вызова: таргеты, до которых не дошли, остаются без кода. */
function finish(
  mode: RunJsResult["mode"],
  done: readonly TargetResult[],
  targets: readonly Ready[],
  call: Call,
  exitCode: number,
): RunJsResult {
  const seen = new Set(done.map((result) => result.label));
  return {
    mode,
    targets: [
      ...done,
      ...targets
        .filter((target) => !seen.has(target.label))
        .map((target) => idle(target.label)),
    ],
    detach: null,
    preview: "",
    output: call.output.captured(),
    exitCode,
  };
}

function idle(label: string): TargetResult {
  return { label, exitCode: null, failure: null };
}

/** Приёмник, копящий оба потока раздельно до завершения таргета. */
function buffer(): {
  readonly sink: RemoteOutput;
  readonly flush: (to: RemoteOutput) => void;
} {
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  return {
    sink: {
      out: (chunk) => out.push(chunk),
      err: (chunk) => err.push(chunk),
      captured: () => "",
    },
    flush: (to) => {
      for (const chunk of out) to.out(chunk);
      for (const chunk of err) to.err(chunk);
    },
  };
}

/**
 * Значение `--jobs`: целое ≥ 0, где 0 — «сколько таргетов, столько и
 * сразу». Тип проверила схема, смысл — здесь
 * (`platform/command-contract.md`, «Ввод/вывод»).
 */
function jobsOf(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new UsageError(`--jobs: ожидалось целое ≥ 0, задано '${raw}'`);
  }
  return raw;
}

/**
 * Способ адресации. Ровно один из трёх; при fan-out первый позиционный
 * токен — это код, а не селектор (спека, «CLI-контракт»).
 */
function scopeOf(args: RunJsArgs): Scope {
  const fanOut = args.all || args["all-containers"] !== undefined;
  if (args.all && args["all-containers"] !== undefined) {
    throw new UsageError(
      "укажите ровно один из <selector> / --all / --all-containers",
    );
  }
  if (!fanOut) {
    if (args.selector === undefined) {
      throw new UsageError(
        "укажите ровно один из <selector> / --all / --all-containers",
      );
    }
    return { kind: "one", selector: args.selector };
  }
  if (args.code !== undefined) {
    throw new UsageError(
      "с --all / --all-containers допустим максимум один позиционный" +
        " (<code>); <selector> избыточен",
    );
  }
  const filter = args["all-containers"];
  return filter === undefined
    ? { kind: "all" }
    : { kind: "containers", filter };
}

/**
 * Код вызова: позиционный, файл, stdin — в этом порядке. Пустой код
 * отвергается до всякого обращения к кэшу и сети.
 */
async function codeOf(args: RunJsArgs, io: RunJsIo): Promise<string> {
  const positional = args.all || args["all-containers"] !== undefined
    ? args.selector
    : args.code;
  if (positional !== undefined && args.file !== undefined) {
    throw new UsageError("позиционный JS и --file взаимоисключающи");
  }
  const code = positional ?? await fromFileOrStdin(args, io);
  if (code.trim() === "") throw new UsageError("пустой JS");
  return code;
}

async function fromFileOrStdin(
  args: RunJsArgs,
  io: RunJsIo,
): Promise<string> {
  if (args.file !== undefined) {
    try {
      return await io.readTextFile(args.file);
    } catch (err) {
      if (err instanceof NotFoundIoError) {
        throw new UsageError(`файл не читается: ${args.file}`, { cause: err });
      }
      throw err;
    }
  }
  if (io.stdinIsTerminal()) {
    io.progress("mpu run-js: введите ESM-код, завершите Ctrl+D");
  }
  return await readTextStdin(io);
}

function keyPath(io: RunJsIo): string {
  const home = io.env("HOME");
  if (home === undefined || home === "") {
    throw new UsageError("путь к ssh-ключу не определён: HOME не задан");
  }
  return `${home}/${KEY_FILE}`;
}

/** Идентификатор фонового запуска: 8 шестнадцатеричных символов. */
function randomDetachId(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(4)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
