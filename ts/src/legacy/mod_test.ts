/**
 * Маршрут `legacy` (`platform/registry.md`): команда исполняется
 * подпроцессом Python-реализации, а её наблюдаемое поведение не
 * отличается от прямого вызова той реализации.
 *
 * Настоящего Python в тестах нет — подставляется фейковый исполнитель:
 * проверяется, что именно ему передали и что вернули пользователю.
 */

import { assertEquals } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { DEFAULT_LEGACY_BIN, legacyBinPath } from "./mod.ts";
import type { CommandIo, LegacyOutcome } from "../command/mod.ts";
import { NotFoundIoError } from "../command/mod.ts";

/** Вызовы фейкового исполнителя: что запускали и с чем. */
interface Recorded {
  readonly bin: string;
  readonly args: readonly string[];
}

function makeCli(
  outcome: LegacyOutcome | (() => never),
  overrides: Partial<CommandIo> = {},
) {
  const calls: Recorded[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io = makeFakeIo({
    runLegacy: (bin, args) => {
      calls.push({ bin, args: [...args] });
      if (typeof outcome === "function") return outcome();
      return Promise.resolve(outcome);
    },
    ...overrides,
  });
  return {
    run: (...argv: string[]) =>
      runCli(argv, io, {
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
      }),
    calls: () => calls,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

const ok: LegacyOutcome = { code: 0, stdout: "", stderr: "" };

Deno.test("вывод и код возврата проходят насквозь", async (t) => {
  await t.step("stdout и код 0", async () => {
    const cli = makeCli({ code: 0, stdout: "строка\tзначение\n", stderr: "" });
    assertEquals(await cli.run("logs", "sl-1"), 0);
    assertEquals(cli.stdout(), "строка\tзначение\n");
    assertEquals(cli.stderr(), "");
  });

  await t.step("stderr и ненулевой код не переупаковываются", async () => {
    const cli = makeCli({ code: 3, stdout: "", stderr: "boom: нет таблицы\n" });
    assertEquals(await cli.run("logs", "sl-1"), 3);
    assertEquals(cli.stderr(), "boom: нет таблицы\n");
    // Ни префикса «mpu logs:», ни подсказки — реестр не вмешивается.
    assertEquals(cli.stdout(), "");
  });

  await t.step("оба потока сразу", async () => {
    const cli = makeCli({ code: 1, stdout: "данные\n", stderr: "шум\n" });
    assertEquals(await cli.run("logs"), 1);
    assertEquals(cli.stdout(), "данные\n");
    assertEquals(cli.stderr(), "шум\n");
  });
});

Deno.test("аргументы уходят как есть, включая незнакомые реестру", async (t) => {
  await t.step("флаги и позиционные", async () => {
    const cli = makeCli(ok);
    await cli.run("logs", "--tail", "10", "sl-1", "--нет-такого-флага");
    assertEquals(cli.calls().length, 1);
    assertEquals(cli.calls()[0].args, [
      "logs",
      "--tail",
      "10",
      "sl-1",
      "--нет-такого-флага",
    ]);
  });

  await t.step("--help исполняет сама реализация", async () => {
    // Справку legacy-команды рендерит подпроцесс: реестр хранит только
    // однострочный summary (спека).
    const cli = makeCli({
      code: 0,
      stdout: "Usage: mpu logs …\n",
      stderr: "",
    });
    assertEquals(await cli.run("logs", "--help"), 0);
    assertEquals(cli.calls()[0].args, ["logs", "--help"]);
    assertEquals(cli.stdout(), "Usage: mpu logs …\n");
  });

  await t.step("--json не распознаётся и уходит подпроцессу", async () => {
    const cli = makeCli(ok);
    await cli.run("logs", "--json", "sl-1");
    assertEquals(cli.calls()[0].args, ["logs", "--json", "sl-1"]);
  });

  await t.step("«--» и всё после него — тоже аргументы", async () => {
    const cli = makeCli(ok);
    await cli.run("logs", "--", "--tail");
    assertEquals(cli.calls()[0].args, ["logs", "--", "--tail"]);
  });
});

Deno.test("путь исполняемого файла берётся из конфига", async (t) => {
  await t.step("ключ mcp.legacy_bin", async () => {
    const cli = makeCli(ok, {
      readConfigStore: () =>
        Promise.resolve(
          JSON.stringify({ values: { "mcp.legacy_bin": "/opt/mpu" } }),
        ),
    });
    await cli.run("logs");
    assertEquals(cli.calls()[0].bin, "/opt/mpu");
  });

  await t.step("без ключа — умолчание спеки с раскрытием «~»", () => {
    assertEquals(
      legacyBinPath(undefined, "/home/проба"),
      `/home/проба${DEFAULT_LEGACY_BIN.slice(1)}`,
    );
    // HOME неизвестен — тильда остаётся как есть: подменять её нечем.
    assertEquals(legacyBinPath(undefined, undefined), DEFAULT_LEGACY_BIN);
    // Голая «~» — сам домашний каталог; «~» внутри пути не трогается.
    assertEquals(legacyBinPath("~", "/home/проба"), "/home/проба");
    assertEquals(legacyBinPath("/opt/~/mpu", "/home/проба"), "/opt/~/mpu");
  });
});

Deno.test("прочий сбой запуска не выдаётся за отсутствие файла", async () => {
  const cli = makeCli(() => {
    throw new Error("диск отвалился");
  });
  // Не NotFoundIoError — значит и не сообщение «не найдена по пути»:
  // такую ошибку обрабатывает верхний обработчик точки входа.
  const err = await cli.run("logs").then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assertEquals(err instanceof Error ? err.message : "", "диск отвалился");
  assertEquals(cli.stderr(), "");
});

Deno.test("нет исполняемого файла — exit 1 и текст спеки", async () => {
  const cli = makeCli(() => {
    throw new NotFoundIoError("no such binary");
  }, {
    readConfigStore: () =>
      Promise.resolve(
        JSON.stringify({ values: { "mcp.legacy_bin": "/нет/такого/mpu" } }),
      ),
  });
  assertEquals(await cli.run("logs", "sl-1"), 1);
  assertEquals(
    cli.stderr(),
    'mpu: legacy-реализация не найдена по пути "/нет/такого/mpu"\n',
  );
  assertEquals(cli.stdout(), "");
});
