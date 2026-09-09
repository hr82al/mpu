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

Deno.test("дерево исходников: два кандидата в порядке, отказ называет оба", async (t) => {
  await withPlan(async (plan) => {
    await t.step("рядом с работающей программой", async () => {
      await Deno.mkdir(`${plan.tree}/bin`, { recursive: true });
      const found = await findSourceTree(`${plan.tree}/bin`, "/nowhere");
      assertEquals(found.tree, plan.tree);
      assertStringIncludes(found.checked[0], plan.tree);
    });
    await t.step("рабочая область по сентинелу", async () => {
      const root = dirOf(plan.tree);
      await Deno.writeTextFile(`${root}/.mp-workspace-root`, "");
      await Deno.mkdir(`${root}/mpu`, { recursive: true });
      await Deno.symlink(plan.tree, `${root}/mpu/ts`);
      const found = await findSourceTree("/nowhere", `${root}/sub/dir`);
      assertEquals(found.tree, `${root}/mpu/ts`);
    });
    await t.step("ни один не подошёл — названы оба места", async () => {
      // Первый кандидат складывается, но дерева там нет; второго нет
      // вовсе — и он всё равно обязан быть назван.
      const found = await findSourceTree(`${plan.home}/пусто`, "/");
      assertEquals(found.tree, undefined);
      assertEquals(found.checked.length, 2, found.checked.join(" | "));
      assertStringIncludes(found.checked[0], "рядом с программой");
      assertStringIncludes(found.checked[1], ".mp-workspace-root");
    });
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
