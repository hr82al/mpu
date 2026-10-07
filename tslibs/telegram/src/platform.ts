/**
 * Платформа клиента Telegram: всё как у библиотеки, кроме потока логов.
 *
 * Обработчик логов библиотеки по умолчанию пишет в `console.log`, то есть в
 * stdout, а stdout подкоманд — данные (`platform/telegram-mtproto.md`,
 * «Логи клиента не попадают в stdout»). Логи уходят в stderr, а не
 * подавляются: уровень по-прежнему задаёт `MTCUTE_LOG_LEVEL`, и это
 * единственная отладочная поверхность клиента, когда соединение не
 * устанавливается.
 */

import { NodePlatform } from "@mtcute/node";

/** Имена уровней библиотеки: индекс — уровень, 0 — выключено. */
const LEVEL_NAMES = ["", "ERR", "WRN", "INF", "DBG", "VRB"];

/** Платформа клиента, пишущая логи библиотеки в stderr. */
export function telegramPlatform(): NodePlatform {
  const platform = new NodePlatform();
  platform.log = (_color, level, tag, fmt, args) => {
    // `console.error`, а не запись в поток stderr: свои подстановки
    // (`%e`, `%j` и прочие) логгер библиотеки заменяет сам, а оставшиеся
    // стандартные (`%s`, `%d`) разбирает консоль.
    console.error(
      `%s [%s] [%s] ${fmt}`,
      new Date().toISOString(),
      LEVEL_NAMES[level] ?? String(level),
      tag,
      ...args,
    );
  };
  return platform;
}
