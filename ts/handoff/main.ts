/**
 * CLI поверх ячейки передачи работы.
 *
 *   deno run --allow-read --allow-write --allow-env handoff/main.ts <команда>
 *
 *   status                    что сейчас в ячейке
 *   post <файл|->             положить постановку (отказ, если прежняя не отработана)
 *   report <файл|->           положить отчёт
 *   read                      напечатать содержимое как есть
 *   wait task|report [сек]    ждать нужный маркер, напечатать и выйти
 *
 * Путь к ячейке — `HANDOFF_CELL`, по умолчанию `.tmp/buf.txt` рядом с модулем.
 * Флаг `--force` снимает защиту от затирания неотработанного содержимого.
 *
 * Коды выхода: 0 — успех, 2 — ошибка ввода, 1 — состояние ячейки.
 */
import {
  type Cell,
  CellError,
  type Kind,
  readCell,
  waitFor,
  writeCell,
} from "./mod.ts";

const DEFAULT_CELL = new URL("../.tmp/buf.txt", import.meta.url).pathname;
const POLL_MS = 2000;

function cellPath(): string {
  return Deno.env.get("HANDOFF_CELL") ?? DEFAULT_CELL;
}

async function source(arg: string | undefined): Promise<string> {
  if (arg === undefined) throw new UsageError("нужен файл или '-' для stdin");
  if (arg === "-") return new TextDecoder().decode(await readAll(Deno.stdin));
  return await Deno.readTextFile(arg);
}

async function readAll(input: typeof Deno.stdin): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of input.readable) chunks.push(chunk);
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

function describe(cell: Cell): string {
  const what = cell.kind === "task" ? "постановка" : "отчёт";
  return `${what} · ${cell.lines} строк`;
}

/** Положить содержимое, не затирая неотработанное молча. */
async function put(kind: Kind, argv: string[]): Promise<string> {
  const force = argv.includes("--force");
  const file = argv.find((arg) => !arg.startsWith("--"));
  const body = await source(file);
  const current = await readCell(cellPath()).catch(() => null);
  if (!force && current?.kind === kind) {
    throw new CellError(
      `в ячейке уже ${
        describe(current)
      } — порция не отработана; повтори с --force`,
    );
  }
  return `ok: ${describe(await writeCell(cellPath(), kind, body))}`;
}

async function run(argv: string[]): Promise<string> {
  const [command, ...rest] = argv;
  switch (command) {
    case "status":
      return describe(await readCell(cellPath()));
    case "read":
      return (await readCell(cellPath())).text.trimEnd();
    case "post":
      return await put("task", rest);
    case "report":
      return await put("report", rest);
    case "wait": {
      const kind = rest[0];
      if (kind !== "task" && kind !== "report") {
        throw new UsageError("ожидается 'wait task' либо 'wait report'");
      }
      const seconds = Number(rest[1] ?? "3600");
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new UsageError(`'${rest[1]}': ожидается число секунд`);
      }
      const cell = await waitFor(cellPath(), kind, {
        everyMs: POLL_MS,
        timeoutMs: seconds * 1000,
      });
      return cell.text.trimEnd();
    }
    default:
      throw new UsageError(
        `неизвестная команда '${
          command ?? ""
        }'; есть status, read, post, report, wait`,
      );
  }
}

if (import.meta.main) {
  try {
    console.log(await run(Deno.args));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`handoff: ${err.message}`);
      Deno.exit(2);
    }
    if (err instanceof CellError) {
      console.error(`handoff: ${err.message}`);
      Deno.exit(1);
    }
    throw err;
  }
}
