import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import {
  build,
  type BuildDeps,
  type BuildPlan,
  findSourceTree,
  type RunOutcome,
} from "./build.ts";

const OK: RunOutcome = { code: 0, stdout: "", stderr: "" };

/** Что подставной сборщик пишет в файл кандидата. */
interface World {
  /** Исход `deno task smoke`. */
  readonly smoke?: RunOutcome;
  /** Версия, которую печатает собранный экземпляр; «» — не отвечает. */
  readonly built?: string;
}

interface Fake {
  readonly deps: BuildDeps;
  readonly calls: string[];
  restarted: boolean;
}

/**
 * Подставной запуск: `deno compile` пишет в файл по `-o` строку версии,
 * а любой экземпляр печатает содержимое своего файла. Так проверяется
 * именно то, что проверяет команда, — файл по пути, а не наш замысел.
 */
function fake(world: World = {}): Fake {
  const calls: string[] = [];
  const result: Fake = {
    calls,
    restarted: false,
    deps: {
      run: async (bin, args) => {
        calls.push([bin, ...args].join(" "));
        if (args[0] === "task" && args[1] === "smoke") {
          return world.smoke ?? OK;
        }
        if (args[0] === "compile") {
          const out = args[args.indexOf("-o") + 1];
          await Deno.writeTextFile(out, world.built ?? "0.2.0");
          return OK;
        }
        const text = await Deno.readTextFile(bin).catch(() => "");
        if (text === "") return { code: 1, stdout: "", stderr: "не отвечает" };
        return { code: 0, stdout: `${text}\n`, stderr: "" };
      },
      restartService: () => {
        result.restarted = true;
        return Promise.resolve({ kind: "restarted" as const });
      },
    },
  };
  return result;
}

/** Дерево исходников и каталог установки на время одной проверки. */
async function withPlan(
  body: (plan: BuildPlan) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const tree = `${root}/ts`;
    await Deno.mkdir(`${tree}`, { recursive: true });
    await Deno.mkdir(`${root}/home/.local/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${tree}/deno.jsonc`,
      '{ "tasks": { "build": "deno compile --allow-read -o $HOME/.local/bin/mpu main.ts" } }',
    );
    await Deno.writeTextFile(`${tree}/main.ts`, "");
    await body({
      tree,
      target: `${root}/home/.local/bin/mpu`,
      home: `${root}/home`,
      configHome: `${root}/home/.config`,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) out.push(entry.name);
  return out.sort();
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

Deno.test("красная проверка оставляет установку побайтово прежней", async () => {
  await withPlan(async (plan) => {
    await Deno.writeTextFile(plan.target, "0.1.0");
    // Форма вывода снята с настоящего smoke: `ok`/`skip` идут в stdout,
    // `FAIL <имя>` и итог — в stderr (`scripts/smoke.ts`).
    const f = fake({
      smoke: {
        code: 1,
        stdout: "== проверки ==\n  ok   version\n",
        stderr: "  FAIL mcp: сокет, токен, аннотации тулов: порт занят\n" +
          "smoke: провалено проверок: 1\n",
      },
    });
    const err = await assertRejects(
      () => build(plan, f.deps, false),
      DomainError,
      "установка не тронута",
    );
    // Упавшая проверка названа: пересказ «smoke красный» скрыл бы, какая.
    assertStringIncludes(err.message, "FAIL mcp:");
    assertEquals(await Deno.readTextFile(plan.target), "0.1.0");
    assertEquals(await names(dirOf(plan.target)), ["mpu"]);
    assertEquals(f.restarted, false);
  });
});

Deno.test("--check не пишет по пути установки ничего", async () => {
  await withPlan(async (plan) => {
    await Deno.writeTextFile(plan.target, "0.1.0");
    const f = fake();
    const outcome = await build(plan, f.deps, true);
    assertEquals(outcome.installed, false);
    assertEquals(outcome.version, null);
    assertEquals(outcome.previous, "0.1.0");
    assertEquals(outcome.service, null);
    assertEquals(await names(dirOf(plan.target)), ["mpu"]);
    assertEquals(await Deno.readTextFile(plan.target), "0.1.0");
    assertEquals(f.restarted, false);
    // Дальше проверки сборки порядок не идёт: компиляции кандидата нет.
    assertEquals(f.calls.some((call) => call.includes("compile")), false);
  });
});

Deno.test("после успешной установки в каталоге установки один файл", async () => {
  await withPlan(async (plan) => {
    await Deno.writeTextFile(plan.target, "0.1.0");
    const f = fake();
    const outcome = await build(plan, f.deps, false);
    assertEquals(outcome.previous, "0.1.0");
    assertEquals(outcome.version, "0.2.0");
    assertEquals(outcome.installed, true);
    assertEquals(outcome.service, { kind: "restarted" });
    assertEquals(await Deno.readTextFile(plan.target), "0.2.0");
    // Ни кандидата, ни сохранённого: каталог установки лежит в PATH.
    assertEquals(await names(dirOf(plan.target)), ["mpu"]);
  });
});

Deno.test("на месте символической ссылки оказывается файл", async () => {
  await withPlan(async (plan) => {
    const real = `${plan.tree}/bin-переключатель`;
    await Deno.writeTextFile(real, "0.0.9");
    await Deno.symlink(real, plan.target);
    await build(plan, fake().deps, false);
    const info = await Deno.lstat(plan.target);
    assertEquals(info.isSymlink, false, "на месте ссылки осталась ссылка");
    assertEquals(info.isFile, true);
    assertEquals(await Deno.readTextFile(plan.target), "0.2.0");
    // Цель ссылки лежит в дереве исходников — туда писать нельзя.
    assertEquals(await Deno.readTextFile(real), "0.0.9");
  });
});

Deno.test("первая установка: прежней версии нет, и это не особый случай", async () => {
  await withPlan(async (plan) => {
    const outcome = await build(plan, fake().deps, false);
    assertEquals(outcome.previous, null);
    assertEquals(outcome.version, "0.2.0");
    assertEquals(await names(dirOf(plan.target)), ["mpu"]);
  });
});

Deno.test("установленное не ответило — прежний экземпляр возвращён", async () => {
  await withPlan(async (plan) => {
    await Deno.writeTextFile(plan.target, "0.1.0");
    const f = fake({ built: "" });
    await assertRejects(() => build(plan, f.deps, false), DomainError);
    assertEquals(await Deno.readTextFile(plan.target), "0.1.0");
    assertEquals(await names(dirOf(plan.target)), ["mpu"]);
    assertEquals(f.restarted, false);
  });
});

/** Файл запомненного дерева в каталоге конфигурации плана. */
function rememberedPath(plan: BuildPlan): string {
  return `${plan.configHome}/mpu/build-source`;
}

async function remember(plan: BuildPlan, text: string): Promise<void> {
  await Deno.mkdir(dirOf(rememberedPath(plan)), { recursive: true });
  await Deno.writeTextFile(rememberedPath(plan), text);
}

async function forget(plan: BuildPlan): Promise<void> {
  try {
    await Deno.remove(rememberedPath(plan));
  } catch (err) {
    // Файла нет — ровно то состояние, которое и нужно.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** Каталог, похожий на дерево исходников: `deno.jsonc` и `main.ts`. */
async function makeTree(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/deno.jsonc`, "{}");
  await Deno.writeTextFile(`${dir}/main.ts`, "");
}

Deno.test("дерево исходников: три кандидата в порядке, отказ называет все три", async (t) => {
  await withPlan(async (plan) => {
    await t.step("рядом с работающей программой", async () => {
      await Deno.mkdir(`${plan.tree}/bin`, { recursive: true });
      const found = await findSourceTree(
        `${plan.tree}/bin`,
        "/nowhere",
        plan.configHome,
      );
      assertEquals(found.tree, plan.tree);
      assertStringIncludes(found.checked[0], plan.tree);
    });
    await t.step("рабочая область по сентинелу", async () => {
      const root = dirOf(plan.tree);
      await Deno.writeTextFile(`${root}/.mp-workspace-root`, "");
      await Deno.mkdir(`${root}/mpu`, { recursive: true });
      await Deno.symlink(plan.tree, `${root}/mpu/ts`);
      const found = await findSourceTree(
        "/nowhere",
        `${root}/sub/dir`,
        plan.configHome,
      );
      assertEquals(found.tree, `${root}/mpu/ts`);
    });
    await t.step(
      "запомненное дерево — из каталога вне рабочей области",
      async (t) => {
        // Первая строка без концевых пробелов и перевода строки; всё после
        // неё не читается.
        const texts = [
          `${plan.tree}\n`,
          plan.tree,
          `${plan.tree} \t\nвторая строка\n`,
        ];
        for (const text of texts) {
          await t.step(JSON.stringify(text), async () => {
            await remember(plan, text);
            const found = await findSourceTree(
              "/nowhere",
              "/",
              plan.configHome,
            );
            assertEquals(found.tree, plan.tree);
            assertEquals(found.checked[2], `запомненное дерево: ${plan.tree}`);
          });
        }
      },
    );
    await t.step("первые два кандидата выигрывают у запомненного", async () => {
      // Своё дерево на шаг: запуск по фильтру не видит следов соседних
      // шагов, и порядок проверяется на том, что создано здесь.
      await withPlan(async (own) => {
        const root = dirOf(own.tree);
        await Deno.mkdir(`${own.tree}/bin`, { recursive: true });
        await Deno.writeTextFile(`${root}/.mp-workspace-root`, "");
        await makeTree(`${root}/mpu/ts`);
        const other = `${root}/другое-дерево`;
        await makeTree(other);
        await remember(own, `${other}\n`);
        const beside = await findSourceTree(
          `${own.tree}/bin`,
          "/",
          own.configHome,
        );
        assertEquals(beside.tree, own.tree);
        const workspace = await findSourceTree(
          "/nowhere",
          `${root}/sub`,
          own.configHome,
        );
        assertEquals(workspace.tree, `${root}/mpu/ts`);
        const remembered = await findSourceTree(
          "/nowhere",
          "/",
          own.configHome,
        );
        assertEquals(remembered.tree, other);
      });
    });
    await t.step(
      "ни один не подошёл — все три места названы дословно",
      async (t) => {
        const empty = `${plan.home}/пусто`;
        const cases: ReadonlyArray<readonly [string, string | null, string]> = [
          ["файла нет", null, "запомненное дерево: не записано"],
          [
            "первая строка пуста",
            `\n${plan.tree}\n`,
            "запомненное дерево: не записано",
          ],
          [
            "первая строка из пробелов",
            " \t\n",
            "запомненное дерево: не записано",
          ],
          [
            "относительный путь",
            "mpu/ts\n",
            "запомненное дерево: mpu/ts — не абсолютный путь",
          ],
          ["путь без дерева", `${empty}\n`, `запомненное дерево: ${empty}`],
        ];
        for (const [name, text, third] of cases) {
          await t.step(name, async () => {
            if (text === null) await forget(plan);
            else await remember(plan, text);
            // Первый кандидат складывается, но дерева там нет; второго нет
            // вовсе — и оба всё равно обязаны быть названы.
            const found = await findSourceTree(empty, "/", plan.configHome);
            assertEquals(found.tree, undefined);
            assertEquals(found.checked, [
              `рядом с программой: ${empty} — не <дерево>/bin`,
              "рабочая область: сентинел .mp-workspace-root не найден от /",
              third,
            ]);
          });
        }
      },
    );
  });
});

Deno.test("нечитаемый build-source не роняет поиск: описан в отказе, первые два выигрывают", async () => {
  await withPlan(async (plan) => {
    const file = rememberedPath(plan);
    // Каталог на месте файла: прочитать нельзя, и это не «не записано».
    await Deno.mkdir(file, { recursive: true });
    const empty = `${plan.home}/пусто`;
    const refused = await findSourceTree(empty, "/", plan.configHome);
    assertEquals(refused.tree, undefined);
    assertEquals(refused.checked.slice(0, 2), [
      `рядом с программой: ${empty} — не <дерево>/bin`,
      "рабочая область: сентинел .mp-workspace-root не найден от /",
    ]);
    // Текст причины — системный, его форма не наша; наш — всё до скобки.
    assertEquals(
      refused.checked[2].startsWith(
        `запомненное дерево: ${file} не прочитан (`,
      ),
      true,
      refused.checked[2],
    );
    await Deno.mkdir(`${plan.tree}/bin`, { recursive: true });
    const found = await findSourceTree(
      `${plan.tree}/bin`,
      "/",
      plan.configHome,
    );
    assertEquals(found.tree, plan.tree);
  });
});

Deno.test("чужое дерево с непонятной задачей build — отказ, а не трасса", async () => {
  await withPlan(async (plan) => {
    await Deno.writeTextFile(`${plan.tree}/deno.jsonc`, '{ "tasks": {} }');
    const err = await assertRejects(
      () => build(plan, fake().deps, false),
      DomainError,
    );
    assertStringIncludes(err.message, "нет задачи build");
    assertStringIncludes(err.message, `${plan.tree}/deno.jsonc`);
  });
});

Deno.test("deno не найден — названа причина, а не трасса", async () => {
  await withPlan(async (plan) => {
    const deps = {
      run: () => Promise.reject(new Deno.errors.NotFound("deno")),
      restartService: () => Promise.resolve({ kind: "untouched" as const }),
    };
    await assertRejects(
      () => build(plan, deps, true),
      DomainError,
      "deno не найден",
    );
  });
});

Deno.test("перезапуск не удался — об установке всё равно сказано", async () => {
  await withPlan(async (plan) => {
    await Deno.writeTextFile(plan.target, "0.1.0");
    const f = fake();
    // Текст — настоящей формы, какую собирает слой службы: с выводом
    // менеджера и подсказкой про журнал, в несколько строк.
    const reason = "systemctl --user restart mpu-mcp.service завершился с 1: " +
      "Job for mpu-mcp.service failed\n" +
      "журнал: journalctl --user -u mpu-mcp.service -n 50";
    const outcome = await build(plan, {
      run: f.deps.run,
      restartService: () =>
        Promise.resolve({ kind: "restart-failed" as const, reason }),
    }, false);
    // Программа заменена — и это главное, что должен узнать владелец.
    assertEquals(outcome.installed, true);
    assertEquals(outcome.version, "0.2.0");
    assertEquals(await Deno.readTextFile(plan.target), "0.2.0");
    assertEquals(outcome.service, { kind: "restart-failed", reason });
  });
});

Deno.test("успешная установка запоминает дерево: одна строка, 0644, без временных файлов", async () => {
  await withPlan(async (plan) => {
    await remember(plan, "/прежнее/дерево\n");
    await Deno.chmod(rememberedPath(plan), 0o600);
    // Брошенный прерванным прогоном временный файл с режимом 0600: запись
    // в существующий файл режим сохраняет, и без явного chmod он доехал бы
    // до build-source — при любом umask, а не только при 0002.
    const stale = `${rememberedPath(plan)}.new`;
    await Deno.writeTextFile(stale, "/брошенное\n");
    await Deno.chmod(stale, 0o600);
    const outcome = await build(plan, fake().deps, false);
    assertEquals(outcome.remembered, { kind: "written" });
    assertEquals(
      await Deno.readTextFile(rememberedPath(plan)),
      `${plan.tree}\n`,
    );
    const mode = (await Deno.stat(rememberedPath(plan))).mode ?? 0;
    assertEquals((mode & 0o777).toString(8), "644");
    assertEquals(await names(dirOf(rememberedPath(plan))), ["build-source"]);
  });
});

Deno.test("первая установка создаёт каталог запомненного дерева", async () => {
  await withPlan(async (plan) => {
    const outcome = await build(plan, fake().deps, false);
    assertEquals(outcome.remembered, { kind: "written" });
    assertEquals(
      await Deno.readTextFile(rememberedPath(plan)),
      `${plan.tree}\n`,
    );
  });
});

Deno.test("запомненное дерево не трогают --check, отказ проверки и возврат прежнего", async (t) => {
  const before = "/прежнее/дерево\n";

  await t.step("--check", async () => {
    await withPlan(async (plan) => {
      await remember(plan, before);
      const outcome = await build(plan, fake().deps, true);
      assertEquals(outcome.remembered, null);
      assertEquals(await Deno.readTextFile(rememberedPath(plan)), before);
      assertEquals(await names(dirOf(rememberedPath(plan))), ["build-source"]);
    });
  });

  await t.step("--check без файла его не создаёт", async () => {
    await withPlan(async (plan) => {
      await build(plan, fake().deps, true);
      assertEquals(
        await Deno.lstat(dirOf(rememberedPath(plan))).then(
          () => true,
          () => false,
        ),
        false,
      );
    });
  });

  await t.step("красная проверка сборки", async () => {
    await withPlan(async (plan) => {
      await remember(plan, before);
      const f = fake({ smoke: { code: 1, stdout: "", stderr: "FAIL x\n" } });
      await assertRejects(() => build(plan, f.deps, false), DomainError);
      assertEquals(await Deno.readTextFile(rememberedPath(plan)), before);
    });
  });

  await t.step("кандидат не ответил", async () => {
    await withPlan(async (plan) => {
      await remember(plan, before);
      const f = fake({ built: "" });
      await assertRejects(() => build(plan, f.deps, false), DomainError);
      assertEquals(await Deno.readTextFile(rememberedPath(plan)), before);
    });
  });

  await t.step(
    "установленное не ответило — прежний экземпляр возвращён",
    async () => {
      await withPlan(async (plan) => {
        await remember(plan, before);
        await Deno.writeTextFile(plan.target, "0.1.0");
        const f = fake();
        // Кандидат отвечает, а установленное после переименования — нет:
        // это и есть возврат прежнего экземпляра, а не отказ кандидата.
        let compiled = false;
        const deps: BuildDeps = {
          ...f.deps,
          run: (bin, args, cwd) => {
            if (args[0] === "compile") compiled = true;
            if (compiled && bin === plan.target) {
              return Promise.resolve({ code: 1, stdout: "", stderr: "нет" });
            }
            return f.deps.run(bin, args, cwd);
          },
        };
        await assertRejects(() => build(plan, deps, false), DomainError);
        assertEquals(await Deno.readTextFile(plan.target), "0.1.0");
        assertEquals(await Deno.readTextFile(rememberedPath(plan)), before);
      });
    },
  );
});

Deno.test("запись запомненного дерева не удалась — установка состоялась, отказ назван", async () => {
  await withPlan(async (plan) => {
    // На месте файла — непустой каталог: переименовать поверх него нельзя.
    await Deno.mkdir(`${rememberedPath(plan)}/занято`, { recursive: true });
    await Deno.writeTextFile(plan.target, "0.1.0");
    const outcome = await build(plan, fake().deps, false);
    assertEquals(outcome.installed, true);
    assertEquals(await Deno.readTextFile(plan.target), "0.2.0");
    assertEquals(outcome.service, { kind: "restarted" });
    assertEquals(outcome.remembered?.kind, "failed");
    assertEquals(
      outcome.remembered?.kind === "failed" && outcome.remembered.reason !== "",
      true,
      "причина отказа пуста",
    );
    // Временный файл убран: рядом остаётся только то, что было.
    assertEquals(await names(dirOf(rememberedPath(plan))), ["build-source"]);
  });
});
