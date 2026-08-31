/**
 * Команда `mpu d2-miro` (`docs/specs/d2-miro.md`): рендер D2-диаграммы
 * на доску Miro редактируемым фреймом.
 *
 * Здесь только склейка контракта: выбор SVG по правилам спеки, чтение
 * конфигурации, `--dry-run` и вызов отрисовки. Разбор входа, план,
 * клиент службы и сама отрисовка — соседние модули, и каждый
 * проверяется без сети.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { parseD2 } from "./d2.ts";
import { type D2MiroEnv, denoD2MiroEnv } from "./env.ts";
import { MiroBoard, MiroError } from "./miro.ts";
import { buildPlan, infoLine, type Plan, planText, warnLines } from "./plan.ts";
import { type Position, renderPlan } from "./render.ts";
import { parseSvg } from "./svg.ts";

const argsSchema = z.object({
  file: z.string().describe("путь к .d2-файлу"),
  title: z.string().optional().describe(
    "title фрейма; по умолчанию имя файла без расширения",
  ),
  board: z.string().optional().describe("разовая замена MIRO_BOARD_ID"),
  position: z.string().optional().describe(
    "координаты центра фрейма x,y (два числа через запятую)",
  ),
  "skip-render": z.boolean().default(false).describe(
    "взять существующий .svg, даже если он старше .d2",
  ),
  "dry-run": z.boolean().default(false).describe(
    "печать плана без единого вызова Miro API",
  ),
});

const resultSchema = z.object({
  title: z.string().describe("title фрейма"),
  shapes: z.number().describe("шейпов в плане"),
  edges: z.number().describe("рёбер в плане"),
  markdown: z.number().describe("markdown-блоков в плане"),
  frameId: z.string().optional().describe("id созданного фрейма"),
  created: z.object({
    shapes: z.number(),
    texts: z.number(),
    connectors: z.number(),
    skipped: z.number(),
    retries: z.number(),
  }).optional().describe("что создано на доске — числами из ответов службы"),
  plan: z.string().optional().describe("текст плана; только у --dry-run"),
});

type D2MiroArgs = z.infer<typeof argsSchema>;
type D2MiroResult = z.infer<typeof resultSchema>;

/** Пути, с которыми работает команда: сам `.d2` и SVG рядом. */
interface Paths {
  readonly d2: string;
  readonly svg: string;
  /** Имя файла без каталога — в строках `[info]` (спека). */
  readonly name: string;
  readonly svgName: string;
  readonly title: string;
}

function pathsOf(file: string, title: string | undefined): Paths {
  const base = file.replace(/\.d2$/, "");
  const name = base.split("/").pop() ?? base;
  return {
    d2: file,
    svg: `${base}.svg`,
    name: `${name}.d2`,
    svgName: `${name}.svg`,
    title: title ?? name,
  };
}

/**
 * Текст файла, который обязан существовать и быть файлом. Отсутствие и
 * каталог — ошибка ввода (exit 2, спека), а не сбой рантайма: иначе
 * пользователь получает `unexpected error: file not found` и код
 * внешних систем.
 */
async function readInput(io: CommandIo, path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await io.readRegularFile(path));
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      throw new UsageError(`${path}: файла нет или это не обычный файл`, {
        cause: err,
      });
    }
    throw err;
  }
}

/** `--position x,y`: два числа, иначе ошибка ввода (exit 2). */
function positionOf(raw: string | undefined): Position | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",");
  // Пустой кусок отсеивается до `Number`: у пустой строки значение 0,
  // и `--position 1,` молча поставил бы фрейм на y=0 вместо отказа.
  const incomplete = parts.length !== 2 ||
    parts.some((part) => part.trim() === "");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (incomplete || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new UsageError(
      `--position: ожидались два числа x,y, получено ${raw}`,
    );
  }
  return { x, y };
}

/**
 * Выбор SVG — правила спеки по порядку. Возвращает текст рендера.
 * Правила выполняются и при `--dry-run`: вызов `d2` может создать или
 * перезаписать `.svg`, и это названо в спеке побочным эффектом.
 */
async function chooseSvg(
  paths: Paths,
  args: D2MiroArgs,
  io: CommandIo,
  env: D2MiroEnv,
): Promise<string> {
  const svgTime = await env.mtime(paths.svg);
  const d2Time = await env.mtime(paths.d2);
  if (
    svgTime !== undefined && (args["skip-render"] || svgTime >= (d2Time ?? 0))
  ) {
    return await readInput(io, paths.svg);
  }
  if (await env.hasD2()) {
    io.progress(`[info] rendering ${paths.name} -> ${paths.svgName}`);
    const outcome = await env.renderSvg(paths.d2, paths.svg);
    if (outcome.code !== 0) {
      throw new DomainError(
        `d2 render failed (${outcome.code}): ${outcome.stderr.trim()}`,
      );
    }
    return await readInput(io, paths.svg);
  }
  if (svgTime !== undefined) {
    io.progress(
      `[warn] d2 CLI not found, using stale ${paths.svg} ` +
        `(file mtime older than .d2)`,
    );
    return await readInput(io, paths.svg);
  }
  throw new DomainError(
    "d2 CLI is not in PATH and no SVG file exists next to the .d2 source. " +
      "Install d2 (https://d2lang.com) or pass --skip-render with a " +
      "pre-rendered .svg.",
  );
}

/**
 * Ключ конфигурации. Текст — платформенный (`envFile.require` называет
 * путь env-файла, чего требует спека), а класс подменяется: у
 * отсутствия конфигурации код 2, а не 1.
 */
function requireKey(io: CommandIo, name: string): string {
  try {
    return io.envFile.require(name);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }
}

async function runD2Miro(
  args: D2MiroArgs,
  io: CommandIo,
  env: D2MiroEnv = denoD2MiroEnv(),
): Promise<D2MiroResult> {
  const paths = pathsOf(args.file, args.title);
  const position = positionOf(args.position);
  const source = parseD2(await readInput(io, paths.d2));
  const layout = parseSvg(await chooseSvg(paths, args, io, env));
  const plan = buildPlan(paths.title, source, layout);
  for (const line of warnLines(plan)) io.progress(line);
  io.progress(infoLine(paths.name, plan));
  const counted = counts(plan);
  if (args["dry-run"]) {
    // Ни одного вызова службы: инвариант спеки, и он держится тем, что
    // клиент здесь вообще не создаётся.
    return { ...counted, plan: planText(plan) };
  }
  const board = new MiroBoard(
    { fetch: env.fetch, sleep: env.sleep, note: io.progress },
    args.board ?? requireKey(io, "MIRO_BOARD_ID"),
    requireKey(io, "MIRO_TOKEN"),
  );
  const created = await asDomain(() => renderPlan(board, plan, position, io));
  io.progress(doneLine(plan, created));
  // Планировалось хоть что-то, а не создано ничего — это провал, и
  // код обязан сказать то же, что числа. Раньше здесь был нулевой код:
  // по букве спеки «успех с пропусками», по существу — пустой фрейм на
  // доске и зелёный код у вызывающего (замер живой пары 89:
  // `shapes=0 connectors=0 skipped=10`, код 0). Частичный успех
  // по-прежнему нулевой: его числа честны, и оператору есть что
  // дочитать.
  //
  // Считаются и шейпы, и markdown-блоки, а не одни шейпы: у входа из
  // одних `|md`-блоков шейпов нет по построению (в SVG они не
  // выходят), и счёт по шейпам пропустил бы ровно тот же пустой фрейм.
  // Обратный промах тоже закрыт: созданный текст при нуле шейпов —
  // не провал, фрейм не пуст.
  const planned = plan.shapes.length + plan.markdown.length;
  if (planned > 0 && created.shapes + created.texts === 0) {
    throw new DomainError(
      `на доске не создано ни одного объекта из ${plan.shapes.length} ` +
        `шейпов и ${plan.markdown.length} markdown-блоков`,
    );
  }
  return {
    ...counted,
    frameId: created.frameId,
    created: {
      shapes: created.shapes,
      texts: created.texts,
      connectors: created.connectors,
      skipped: created.skipped,
      retries: created.retries,
    },
  };
}

/**
 * Отказ службы наружу уходит доменной ошибкой: точка входа печатает её
 * как `mpu d2-miro: <причина>` с кодом 1, а не «unexpected error» с
 * трейсом — это отклонение-fix спеки.
 */
async function asDomain<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof MiroError) {
      throw new DomainError(err.message, { cause: err });
    }
    throw err;
  }
}

/** Числа плана — общая часть результата обоих режимов. */
function counts(plan: Plan): Omit<D2MiroResult, "plan" | "created"> {
  return {
    title: plan.title,
    shapes: plan.shapes.length,
    edges: plan.edges.length,
    markdown: plan.markdown.length,
  };
}

/**
 * Итоговая строка: числа сделанного, а не запланированного. Пропуски и
 * повторы названы, иначе частично собранный фрейм выглядел бы целым
 * (инвариант спеки).
 */
function doneLine(
  plan: Plan,
  created: {
    shapes: number;
    connectors: number;
    skipped: number;
    retries: number;
  },
): string {
  const tail = [
    created.skipped === 0 ? "" : ` skipped=${created.skipped}`,
    created.retries === 0 ? "" : ` retries=${created.retries}`,
  ].join("");
  return `[done] frame='${plan.title}' shapes=${created.shapes} ` +
    `connectors=${created.connectors}${tail}`;
}

export const d2MiroCommand = defineCommand({
  path: ["d2-miro"],
  errorName: "d2-miro",
  summary: "Рендер d2-диаграммы в Miro как редактируемый фрейм.",
  usage:
    "mpu d2-miro D2_FILE [--title T] [--board ID] [--position x,y] [--skip-render] [--dry-run]",
  help: `Рисует .d2 на доске Miro редактируемым фреймом: шейпы и тексты по
layout'у SVG, connectors по рёбрам. Повторный рендер идемпотентен —
фрейм с тем же title удаляется со всем содержимым (включая залоченное:
блокировка снимается) и создаётся заново на прежнем месте.

SVG берётся рядом с .d2: свежий — как есть, устаревший — пере-рендер
через d2 из PATH; d2 нет и SVG нет — отказ. --skip-render берёт
существующий SVG даже устаревшим.

--dry-run печатает план и не делает ни одного вызова Miro API; правила
выбора SVG при этом выполняются, то есть d2 может перезаписать .svg.

Имя шейпа исходника читается как [a-zA-Z_]\\w*, метка — из кавычек.
Имя вне этого класса пары в исходнике не находит: шейп рисуется
умолчанием, а сколько таких — сказано числом в строке [info].

Конфигурация: MIRO_TOKEN и MIRO_BOARD_ID из env-файла (--board
заменяет второй разово).

Exit: 0 — успех, в том числе с пропусками, если создано хоть что-то;
2 — ошибки ввода и конфигурации; 1 — отказ Miro API, сбой d2-рендера, а
также прогон, не создавший на доске ничего: числа итога и код возврата
обязаны говорить одно и то же.`,
  policy: "rw",
  argsSchema,
  forms: { file: { positional: "one" } },
  resultSchema,
  run: (args: D2MiroArgs, io: CommandIo) => runD2Miro(args, io),
  render: (result: D2MiroResult) => result.plan ?? "",
});

/**
 * Тот же вход, но с подставленным внешним миром. Экспортируется из
 * этого файла, а не из `mod.ts`: публичная поверхность модуля — сама
 * команда, а порт нужен только её тестам (`ts/CLAUDE.md`: API не
 * расширяется ради тестов).
 */
export const runD2MiroWith = runD2Miro;
