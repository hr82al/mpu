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

Deno.test("запомненное дерево читается из $XDG_CONFIG_HOME/mpu, пустая или относительная — $HOME/.config", async (t) => {
  const cases: ReadonlyArray<
    readonly [string, (home: string) => string | undefined, string]
  > = [
    ["XDG_CONFIG_HOME задана", (home) => `${home}/xdg`, "xdg"],
    ["XDG_CONFIG_HOME пуста", () => "", ".config"],
    // Относительная — как незаданная (`platform/env-file.md`): тот же путь
    // держат и права собираемого бинаря, поэтому команда обязана брать
    // каталог общим правилом, а не читать переменную сама.
    ["XDG_CONFIG_HOME относительная", () => "cfg", ".config"],
    ["XDG_CONFIG_HOME не задана", () => undefined, ".config"],
  ];
  for (const [name, xdg, configDir] of cases) {
    await t.step(name, async () => {
      const home = await Deno.makeTempDir();
      try {
        // Дерева по запомненному пути нет: отказ называет путь, который
        // команда прочла, — по нему и видно, из какого каталога.
        const missing = `${home}/нет-дерева`;
        await Deno.mkdir(`${home}/${configDir}/mpu`, { recursive: true });
        await Deno.writeTextFile(
          `${home}/${configDir}/mpu/build-source`,
          `${missing}\n`,
        );
        const io = makeFakeIo({
          env: (key) =>
            key === "HOME"
              ? home
              : key === "XDG_CONFIG_HOME"
              ? xdg(home)
              : undefined,
          // Корень: над ним нет сентинела рабочей области, где бы ни лежал
          // временный каталог.
          cwd: () => "/",
        });
        const err = await assertRejects(
          () => buildCommand.invoke(["--check"], io),
          DomainError,
        );
        assertEquals(
          err.message.endsWith(`, запомненное дерево: ${missing}`),
          true,
          err.message,
        );
      } finally {
        await Deno.remove(home, { recursive: true });
      }
    });
  }
});

Deno.test("итог печатается по-разному для установки и для --check", async (t) => {
  const common = {
    tree: "/w/mpu/ts",
    target: "/h/.local/bin/mpu",
    previous: "0.1.0",
  };
  await t.step("установка", () => {
    const result = {
      ...common,
      version: "0.2.0",
      installed: true,
      service: { kind: "restarted" as const },
      remembered: { kind: "written" as const },
    };
    const text = buildCommand.renderResult(result, []);
    assertStringIncludes(text, "собрано: 0.2.0");
    assertStringIncludes(text, "было: 0.1.0");
    assertStringIncludes(
      text,
      "установлено: /h/.local/bin/mpu\nзапомненное дерево: /w/mpu/ts\n",
    );
    assertStringIncludes(text, "перезапущена");
    assertEquals(text.includes("--check"), false);
    assertEquals(buildCommand.textExitCode(result), 0);
  });
  await t.step("запись запомненного дерева не удалась: строка и код 0", () => {
    const result = {
      ...common,
      version: "0.2.0",
      installed: true,
      service: { kind: "untouched" as const },
      remembered: {
        kind: "failed" as const,
        reason: "Is a directory (os error 21)",
      },
    };
    const text = buildCommand.renderResult(result, []);
    assertStringIncludes(text, "установлено: /h/.local/bin/mpu\n");
    assertStringIncludes(
      text,
      "\nзапомненное дерево: не записано (Is a directory (os error 21))\n",
    );
    assertEquals(buildCommand.textExitCode(result), 0);
  });
  await t.step("--check", () => {
    const text = buildCommand.renderResult({
      ...common,
      version: null,
      installed: false,
      service: null,
      remembered: null,
    }, []);
    assertStringIncludes(text, "установка не тронута (--check)");
    assertEquals(text.includes("установлено:"), false);
    assertEquals(text.includes("запомненное дерево"), false);
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
      remembered: { kind: "written" as const },
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
      remembered: { kind: "written" },
    }, []);
    assertStringIncludes(text, "было: ничего не установлено");
    assertStringIncludes(text, "не тронута");
  });
});
