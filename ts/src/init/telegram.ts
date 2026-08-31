/**
 * Шаг 5 команды `mpu init` (`docs/specs/init.md`): вход в Telegram.
 * Своей семантики у шага нет — он зовёт ту же реализацию, что и
 * команда `mpu telegram login` (`telegram-login.md`), напрямую.
 *
 * До порции 95 шаг запускал Python-версию подпроцессом: MTProto тогда
 * жил только там. После переезда входа (порция 90) две реализации
 * одного шага стояли рядом и могли разойтись молча — у `init` не было
 * ни одной проверки, сверяющей его исход с командой. Вместе с
 * подпроцессом исчезли и причины пропуска «код возврата N» и
 * «прежняя реализация не найдена»: ломаться на запуске больше нечему.
 *
 * Исход шага код выхода `init` не меняет: функция не бросает, а
 * возвращает причину пропуска либо `null`.
 */

import type { CommandIo } from "../command/mod.ts";
import { firstLine } from "../http/mod.ts";
import { runTelegramLoginStep } from "../telegram/mod.ts";

/** Срез порта: ровно то, что нужно самому входу. */
export type TelegramIo = Pick<
  CommandIo,
  "envFile" | "openTerminal" | "progress"
>;

/**
 * Выполняет вход. `null` — сессия записана либо уже была; иначе
 * причина для строки `# telegram: пропущено (<причина>)`.
 *
 * Отказ входа шаг не обрывает: он best-effort по спеке, и `init`
 * заканчивается своим кодом независимо от Telegram. Причина при этом
 * называется — молчаливого пропуска не бывает.
 */
export async function runTelegramLogin(
  io: TelegramIo,
): Promise<string | null> {
  try {
    const result = await runTelegramLoginStep(io);
    return result.status === "skipped" ? result.reason : null;
  } catch (err) {
    // Строку пропуска печатает сам вход, но до неё он не дошёл: сюда
    // попадают сбои раньше любой его ветки — отказ терминала, отказ
    // записи в env-файл, падение самого Telegram. Молчаливого пропуска
    // не бывает (`init.md`, шаги 3–5 best-effort), поэтому строку
    // печатаем здесь — единственный случай, когда это делает шаг.
    const reason = firstLine(err instanceof Error ? err.message : String(err));
    io.progress(`# telegram: пропущено (${reason})`);
    return reason;
  }
}
