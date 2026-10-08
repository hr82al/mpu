/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`) над настоящим
 * портом файлов приложения (`makeDenoIo`): каталог вместо файла-вложения —
 * тот же отказ ввода, что и отсутствующий файл, до конфигурации и сети
 * (разбор ввода — первый шаг `run`; `invokeInput` зовёт его с проверенным
 * входом). Прочий разбор ввода проверяет пакет `@mpu/cmd-telegram` на
 * фейковом порте.
 */

import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { UsageError } from "@mpu/command";
import { telegramLogCommand } from "@mpu/cmd-telegram";
import { makeDenoIo } from "../../runtime/mod.ts";

it("каталог вместо файла — тот же отказ, не падение чтения", async () => {
  // Порт настоящий: «каталог вместо файла» отбивает именно он
  // (`readRegularFile`), и проверять это на фейке нечего.
  const real = makeDenoIo("/nowhere");
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const err = await rejected(
      () =>
        telegramLogCommand.invokeInput({ message: "текст", file: dir }, real),
      UsageError,
    );
    expect(err.message).toStrictEqual(`файл-вложение не найден: ${dir}`);
  } finally {
    await rmdir(dir);
  }
});
