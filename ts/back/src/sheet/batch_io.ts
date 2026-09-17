/**
 * Общая часть двух пакетных команд (`docs/specs/sheet-batch.md`):
 * сбор скрипта из трёх источников и срез порта.
 *
 * Отдельно от команд, потому что источник скрипта у них один и тот же,
 * а второй копии правила «нет `-e` и `--from` → читаем stdin» быть не
 * должно: разойдясь, они дали бы двум соседним подкомандам разный
 * способ позвать себя.
 */

import { type CommandIo, readTextStdin, UsageError } from "../command/mod.ts";
import { fileText, type SheetIo } from "./sources.ts";

/** Срез порта пакетных команд: то же, что у чтения, плюс признак tty. */
export type BatchIo = SheetIo & Pick<CommandIo, "note" | "stdinIsTerminal">;

/** Ввод скрипта: повторяемые `-e` и файл `--from`. */
export interface ScriptInput {
  readonly expressions: readonly string[];
  readonly from?: string;
}

/**
 * Скрипт вызова: все `-e` плюс содержимое `--from`, склейка переводом
 * строки. Ни того, ни другого нет, а stdin не терминал — скрипт
 * читается оттуда: так работает `… | mpu sheet batch-update`.
 */
export async function scriptOf(
  io: BatchIo,
  input: ScriptInput,
): Promise<string> {
  const parts = [...input.expressions];
  if (input.from !== undefined) {
    parts.push(
      input.from === "-"
        ? await readTextStdin(io)
        : await fileText(io, input.from),
    );
  } else if (parts.length === 0 && !io.stdinIsTerminal()) {
    parts.push(await readTextStdin(io));
  }
  const script = parts.join("\n");
  if (script.trim() === "") {
    throw new UsageError("пустой скрипт (-e / --from / stdin)");
  }
  return script;
}
