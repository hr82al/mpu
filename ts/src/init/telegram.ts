/**
 * Шаг 5 команды `mpu init` (`docs/specs/init.md`): вход в Telegram.
 * Своей семантики у шага нет — он запускает подкоманду `mpu telegram
 * login` установленной Python-реализации подпроцессом с проброшенным
 * терминалом, и вся логика (идемпотентность при живой сессии, пропуск
 * без TTY, интерактив, запись `TELEGRAM_*` в env-файл) остаётся у неё.
 *
 * Исход шага код выхода init не меняет: функция не бросает, а
 * возвращает причину пропуска.
 */

import { type CommandIo, NotFoundIoError } from "../command/mod.ts";
import { resolveLegacyBin } from "../legacy/mod.ts";
import { firstLine } from "../http/mod.ts";

/** Сегменты имени подкоманды входа — те же, что у маршрута `legacy`. */
const LOGIN_PATH: readonly string[] = ["telegram", "login"];

/**
 * Срез порта исполнения: путь к прежней реализации (ключ конфига и
 * HOME) плюс её запуск с проброшенным терминалом.
 */
export type TelegramIo = Pick<
  CommandIo,
  "env" | "openCacheDb" | "runLegacyInteractive"
>;

/**
 * Запускает `mpu telegram login`. Возвращает `null`, если подпроцесс
 * отработал с нулевым кодом, иначе — причину для строки
 * `# telegram: пропущено (<причина>)`.
 *
 * Поток вывода подпроцесса не перехватывается: терминал проброшен
 * целиком, и пользователь видит интерактив входа как есть (спека).
 */
export async function runTelegramLogin(
  io: TelegramIo,
): Promise<string | null> {
  const bin = resolveLegacyBin(io);
  let code: number;
  try {
    code = await io.runLegacyInteractive(bin, LOGIN_PATH);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      // Та же формулировка, что у маршрута `legacy` (`src/legacy/mod.ts`):
      // причина одна и та же, и пользователю незачем видеть два текста
      // про один и тот же ненайденный файл.
      return `legacy-реализация не найдена по пути "${bin}"`;
    }
    // Прочий сбой запуска (например, гонка «файл удалили после
    // проверки») шаг тоже не обрывает: он best-effort по спеке.
    return firstLine(err instanceof Error ? err.message : String(err));
  }
  return code === 0 ? null : `код возврата ${code}`;
}
