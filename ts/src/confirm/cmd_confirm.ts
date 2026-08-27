/**
 * Команда `mpu confirm` (`docs/specs/confirm.md`): y/N-ворота в пайпе.
 *
 * Данные идут через stdin, а вопрос задаётся терминалу: stdin занят, и
 * спрашивать по нему нечего. Отсюда отдельный порт `openTerminal` —
 * без него команда либо читала бы ответ из данных, либо не работала бы
 * в конвейере вовсе.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  readTextStdin,
  UsageError,
} from "../command/mod.ts";
import { echoLine, isYes, ttyDiagnostics } from "./gate.ts";

const argsSchema = z.object({
  message: z.string().default("Применить?").describe(
    "текст вопроса; по умолчанию «Применить?»",
  ),
  yes: z.boolean().default(false).describe(
    "не спрашивать: ворота пропускают всё (для скриптов)",
  ),
});

const resultSchema = z.object({
  text: z.string().describe("буфер, пропущенный воротами, как есть"),
});

type ConfirmArgs = z.infer<typeof argsSchema>;
type ConfirmResult = z.infer<typeof resultSchema>;

/** Отказ, когда спрашивать некому: терминала у процесса нет. */
const NO_TERMINAL =
  "терминал недоступен для подтверждения. Используй `--yes` или " +
  "two-step (`<команда> > /tmp/x.json` → проверить → " +
  "`mpu sheet set <ssid> < /tmp/x.json`).";

/** Срез порта: данные, терминал и признаки std-fd для диагностики. */
type ConfirmIo = Pick<
  CommandIo,
  | "readStdin"
  | "openTerminal"
  | "progress"
  | "stdinIsTerminal"
  | "stdoutIsTerminal"
  | "stderrIsTerminal"
>;

async function runConfirm(
  args: ConfirmArgs,
  io: ConfirmIo,
): Promise<ConfirmResult> {
  const text = await readTextStdin(io);
  // Эхо идёт до развилки, то есть и при `--yes`: оператор смотрит на
  // то, что проходит по конвейеру, в том числе в скриптовом режиме —
  // в этом и смысл ворот (`docs/specs/confirm.md`).
  io.progress(echoLine(text));
  // `--yes` пропускает всё дальше без вопроса: спрашивать в скрипте
  // некого.
  if (args.yes) return { text };
  using terminal = await io.openTerminal();
  if (terminal === undefined) {
    throw new UsageError(NO_TERMINAL, { details: ttyDiagnostics(io) });
  }
  await terminal.write(`${args.message} [y/N] `);
  const answer = await terminal.readLine();
  // Отказ — обычный исход ворот, а не сбой: код 1, stdout пуст.
  if (!isYes(answer)) throw new DomainError("отменено — pipe прерван.");
  return { text };
}

export const confirmCommand = defineCommand({
  path: ["confirm"],
  summary: "y/N-ворота в пайпе: показать буфер и спросить у терминала.",
  usage: "mpu confirm [-m ТЕКСТ] [-y]",
  help: `Читает весь stdin, показывает его в stderr и спрашивает
подтверждение У ТЕРМИНАЛА, а не со stdin: stdin занят данными. На «да»
буфер уходит в stdout как есть, и конвейер продолжается.

Ставится между командами: mpu sheet get … | mpu confirm | mpu sheet set …

-m/--message ТЕКСТ — текст вопроса; по умолчанию «Применить?».
-y/--yes — не спрашивать вовсе: ворота пропускают буфер дальше без
вопроса. Эхо в stderr при этом остаётся: оно и есть смысл ворот. Это
форма для скриптов.

Ответ «да» — y либо yes, регистр не важен. Пустой ответ, Enter и любое
другое слово означают «нет»: умолчание у ворот отрицательное, оттого и
[y/N] в приглашении.

Буфер эхо-печатается дословно; перевод строки в конце добавляется, если
его не было, — в stdout при этом уходит исходный буфер, без него. Идёт
он текстом UTF-8: двоичный поток через ворота пропускать нельзя.

Ни аргументы, ни вывод в журнал вызовов не пишутся: вывод здесь
дословно равен вводу, а это чужой буфер конвейера.

Exit: 0 — «да», буфер в stdout; 1 — «нет», stdout пуст; 2 — терминала
нет (пайп без tty, cron, вызов тула) — тогда печатается диагностика по
трём std-fd, и выход из положения два: --yes либо two-step через файл.

Тулом MCP-сервера команда не публикуется: у вызова тула нет ни stdin, ни
терминала, а без них у ворот нет ни данных, ни собеседника.

Примеры: mpu run-js … | mpu confirm -m 'Записать в прод?' | mpu sql …;
mpu run-js … | mpu confirm -y | mpu sql …`,
  // Читающая: сама команда ничего не меняет — она пропускает или
  // отбивает чужие данные.
  policy: "ro",
  // Вывод скрыт: он дословно равен вводу, а ввод — чужой буфер
  // конвейера, который журналу не принадлежит и приходит через stdin,
  // мимо маски аргументов. Решение то же, что у `users add`, только
  // тип его здесь не требует: аргументы у ворот безобидны.
  logsOutput: false,
  argsSchema,
  forms: {
    message: { short: "m" },
    yes: { short: "y" },
  },
  resultSchema,
  run: runConfirm,
  render: (result: ConfirmResult) => result.text,
});
