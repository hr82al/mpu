/**
 * Поверхность `mpu build`: что команда берёт из окружения вызова и как
 * печатает итог. Сама установка проверяется в `build_test.ts` — там у
 * неё подставной сборщик, здесь настоящего дерева нет.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { buildCommand } from "./cmd_build.ts";

Deno.test("без HOME путь установки не вычислить — отказ", async () => {
  await assertRejects(
    () => buildCommand.invoke(["--check"], makeFakeIo()),
    DomainError,
    "HOME не задана",
  );
});

Deno.test("дерево исходников не найдено — отказ называет проверенные места", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const io = makeFakeIo({
      env: (name) => name === "HOME" ? dir : undefined,
      cwd: () => dir,
    });
    const err = await assertRejects(
      () => buildCommand.invoke(["--check"], io),
      DomainError,
      "дерево исходников не найдено",
    );
    assertStringIncludes(err.message, "проверены:");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("итог печатается по-разному для установки и для --check", async (t) => {
  const common = {
    tree: "/w/mpu/ts",
    target: "/h/.local/bin/mpu",
    previous: "0.1.0",
  };
  await t.step("установка", () => {
    const text = buildCommand.renderResult({
      ...common,
      version: "0.2.0",
      installed: true,
      service: { kind: "restarted" },
    }, []);
    assertStringIncludes(text, "собрано: 0.2.0");
    assertStringIncludes(text, "было: 0.1.0");
    assertStringIncludes(text, "установлено: /h/.local/bin/mpu");
    assertStringIncludes(text, "перезапущена");
    assertEquals(text.includes("--check"), false);
  });
  await t.step("--check", () => {
    const text = buildCommand.renderResult({
      ...common,
      version: null,
      installed: false,
      service: null,
    }, []);
    assertStringIncludes(text, "установка не тронута (--check)");
    assertEquals(text.includes("установлено:"), false);
  });
  await t.step("перезапуск не удался: обе строки и код 1", () => {
    const result = {
      ...common,
      version: "0.2.0",
      installed: true,
      service: {
        kind: "restart-failed" as const,
        // Текст закреплён снимающим тестом на шве службы
        // (`src/mcp/cmd_service_test.ts`, «менеджер отказал»).
        reason:
          "systemctl --user restart mpu-mcp.service завершился с 1: Job for " +
          "mpu-mcp.service failed\nжурнал: journalctl --user -u " +
          "mpu-mcp.service -n 50",
      },
    };
    const text = buildCommand.renderResult(result, []);
    // Установка состоялась — и это видно, несмотря на отказ.
    assertStringIncludes(text, "установлено: /h/.local/bin/mpu");
    assertStringIncludes(text, "перезапуск не удался — systemctl --user");
    // Подсказка про журнал доезжает целиком: усечение до первой строки
    // выбросило бы ровно то, ради чего эта ветка и появилась.
    assertStringIncludes(text, "journalctl --user -u");
    assertEquals(buildCommand.textExitCode(result), 1);
  });
  await t.step("первая установка: прежней версии не было", () => {
    const text = buildCommand.renderResult({
      ...common,
      previous: null,
      version: "0.2.0",
      installed: true,
      service: { kind: "untouched" },
    }, []);
    assertStringIncludes(text, "было: ничего не установлено");
    assertStringIncludes(text, "не тронута");
  });
});
