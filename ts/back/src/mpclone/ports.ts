/**
 * Внешнее команды `mpu mp-clone`: подпроцессы, диск и часы — порты с
 * настоящими реализациями. Тесты подменяют подпроцессы и часы, а диск
 * берут настоящий, во временном `HOME`.
 */

import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { hasErrorCode } from "../oserror/mod.ts";
import { startProgram } from "../subprocess/mod.ts";

/** Итог подпроцесса: код и собранные потоки. */
export interface ProcessOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Запуск подпроцессов: `git`, `ssh-keygen`, `ssh-keyscan`, `cp`, `mkdir`,
 * `rm`. Вывод собирается всегда: stdout команды пуст, а всё, что видит
 * оператор, печатает сама команда строками хода.
 */
export interface Shell {
  run(argv: readonly string[], stdin?: string): Promise<ProcessOutcome>;
}

/** Диск: чтения и две записи, которые команда делает сама. */
export interface Disk {
  exists(path: string): boolean;
  /** Путь без символических ссылок — так его печатает `git`. */
  realPath(path: string): string;
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  /** Обычные файлы под каталогом, пути относительно него. */
  filesUnder(dir: string): readonly string[];
  writeText(path: string, text: string): void;
}

/** Часы: штамп каталога копий, `ГГГГММДД-ччммсс`. */
export interface Clock {
  stamp(): string;
}

/** Настоящие подпроцессы. Нет программы — код 127, как у оболочки. */
export const systemShell: Shell = {
  async run(argv, stdin) {
    const [bin, ...args] = argv;
    try {
      const child = await startProgram(bin, {
        args,
        stdin: stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      });
      if (stdin !== undefined) await feed(child.stdin, stdin);
      const output = await child.output();
      const decoder = new TextDecoder();
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    } catch (err) {
      if (!hasErrorCode(err, "ENOENT")) throw err;
      return { code: 127, stdout: "", stderr: `${bin}: не найден` };
    }
  },
};

/** Текст в stdin; процесс, вышедший не дочитав, скажет о себе кодом. */
async function feed(
  stdin: WritableStream<Uint8Array>,
  text: string,
): Promise<void> {
  const writer = stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
  } catch (err) {
    if (!hasErrorCode(err, "EPIPE")) throw err;
  }
}

/** Настоящий диск. */
export const systemDisk: Disk = {
  exists(path) {
    try {
      lstatSync(path);
      return true;
    } catch (err) {
      if (hasErrorCode(err, "ENOENT")) return false;
      throw err;
    }
  },
  realPath: (path) => realpathSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  readBytes: (path) => new Uint8Array(readFileSync(path)),
  filesUnder: (dir) => walk(dir, ""),
  writeText: (path, text) => writeFileSync(path, text),
};

/** Обход без перехода по ссылкам: ссылка — не файл пустышки. */
function walk(dir: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isFile()) found.push(rel);
    if (entry.isDirectory()) {
      found.push(...walk(`${dir}/${entry.name}`, `${rel}/`));
    }
  }
  return found.sort();
}

/** Настоящие часы, местное время. */
export const systemClock: Clock = {
  stamp() {
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(
      now.getDate(),
    )}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  },
};
