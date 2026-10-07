/**
 * Ошибки семейства `telegram` у слоя команд
 * (`docs/specs/platform/telegram-mtproto.md`, «Ошибки и коды выхода»): одна
 * строка вида `telegram: <причина>`, без трейсбеков, с кодом 2 у ошибок
 * ввода и 1 у прочих.
 *
 * Отказы слоя Telegram приходят из `@mpu/telegram` его классами, и здесь они
 * становятся классами контракта команды (`commandError`). Форму строки несёт
 * сам слой, поэтому общий префикс точки входа (`mpu <команда>: `) к ней не
 * добавляется — отсюда дословные классы.
 */

import { TelegramError, TelegramInputError } from "@mpu/telegram";
import {
  type ErrorDetails,
  VerbatimError,
  VerbatimUsageError,
} from "../command/mod.ts";

/**
 * Ошибка ввода, которую находит сама команда (флаги, текст заметки): форма
 * строки та же, что у слоя. Код выхода 2, до сети.
 */
export function inputError(
  reason: string,
  opts?: ErrorDetails,
): VerbatimUsageError {
  return new VerbatimUsageError(`telegram: ${reason}`, opts);
}

/**
 * Отказ слоя Telegram — классом контракта команды: ошибка ввода — кодом 2,
 * отказ конфигурации или Telegram — кодом 1, текст — дословно. Прочее —
 * дефект своего кода, отказ терминала — уходит тем же объектом.
 */
export function commandError(err: unknown): unknown {
  if (err instanceof TelegramInputError) {
    return new VerbatimUsageError(err.message, { cause: err });
  }
  if (err instanceof TelegramError) {
    return new VerbatimError(err.message, { cause: err });
  }
  return err;
}

/**
 * Исполняет работу команды поверх `@mpu/telegram`: её отказы уходят
 * классами контракта команды. Стоит в `run` каждой команды, а не в точке
 * входа: точек входа три (CLI, MCP, сервер строк), а команду зовут и
 * напрямую.
 */
export async function asCommand<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw commandError(err);
  }
}
