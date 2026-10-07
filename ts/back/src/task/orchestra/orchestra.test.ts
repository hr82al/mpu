/**
 * Сценарии O1–O18 оркестратора (`task-orchestrator.md`, «Сценарии») на
 * стенде `teststage.ts`: поддельный tmux, поддельная роль, настоящий канал.
 */

import { assert, expect, it, vi } from "vitest";
import { fakeTimers } from "../../testing/scope.ts";
import { withStand } from "../teststand.ts";
import { RESUME_LINE } from "./letter.ts";
import { demo, ENTER, LETTER_DIR, Rig, shellWords } from "./teststage.ts";

const MINUTE = 60_000;

function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  return withStand(async (stand) => {
    fakeTimers({ now: Date.UTC(2026, 8, 26, 10) });
    await body(new Rig(stand, { tick: (ms) => vi.advanceTimersByTime(ms) }));
  });
}

/** Окна обеих ролей живы, отметки — `idle`: запуска на шаге не будет. */
async function settled(rig: Rig, project = "demo") {
  rig.tmux.alive(`${project}-host`);
  rig.tmux.alive(`${project}-exec`);
  await rig.mark("host", "idle", project);
  await rig.mark("exec", "idle", project);
}

function message(project: string, role: string): string {
  return `Прочитай файл ${LETTER_DIR}/${project}/${role}.md целиком и выполняй его.`;
}

/** Раздел «Что делать сейчас» файла первого сообщения. */
function nowOf(letter: string): string {
  return letter.split("## Что делать сейчас\n\n")[1]?.split("\n## ")[0] ?? "";
}

function launches(rig: Rig, window: string): string[] {
  return rig.tmux.keys(window).filter((key) => key.startsWith("claude "));
}

it("O1: окон нет — два окна, сообщение первым аргументом, Enter отдельно", () =>
  withRig(async (rig) => {
    await demo(rig);
    await rig.step();
    for (const role of ["host", "exec"]) {
      expect(rig.tmux.keys(`demo-${role}`)).toStrictEqual([
        `claude "${
          message("demo", role)
        }" --permission-mode auto --model opus --name demo-${role}`,
        ENTER,
      ]);
      expect(rig.tmux.panes.get(`w:demo-${role}`)?.command).toBe("claude");
    }
    expect(nowOf(rig.letter("exec"))).toBe(
      "дела нет — жди: mpu task wait project: demo kind: task\n",
    );
    expect(nowOf(rig.letter("host"))).toBe(
      "дела нет — жди: mpu task wait project: demo kind: report\n",
    );
  }));

it("O2: add-dir — после --name, сообщение по-прежнему первым", () =>
  withRig(async (rig) => {
    await demo(rig, "add-dir:", "/tmp/a");
    await rig.step();
    const [line] = launches(rig, "demo-exec");
    assert(line.endsWith("--name demo-exec --add-dir /tmp/a"), line);
    expect(shellWords(line)[1]).toStrictEqual(message("demo", "exec"));
  }));

it("O3: сессии нет — создана, окно в ней", () =>
  withRig(async (rig) => {
    await demo(rig, "session:", "a");
    await rig.step();
    assert(rig.tmux.sessions.has("a"));
    expect(rig.tmux.panes.get("a:demo-exec")?.command).toBe("claude");
    expect(launches(rig, "demo-exec")).toStrictEqual([]);
    expect(rig.tmux.keys("demo-exec", "a").length).toBe(2);
  }));

it("O4: роль не печатает ❯ — после третьего запуска остановлена, одно уведомление", () =>
  withRig(async (rig) => {
    await demo(rig);
    rig.tmux.scripts.set("demo-exec", { silent: true });
    for (let i = 0; i < 6; i++) {
      await rig.step();
      rig.pass(MINUTE + 1000);
    }
    expect(launches(rig, "demo-exec").length).toBe(3);
    const halted =
      "demo exec: не запускается (3 попытки) — вернуть: systemctl --user restart mpu";
    expect(rig.notices.notified).toStrictEqual([halted]);
    expect(rig.notices.logged).toStrictEqual([halted]);
    await rig.step();
    await rig.step();
    expect(launches(rig, "demo-exec").length).toBe(3);
    expect(launches(rig, "demo-host").length).toBe(1);
  }));

it("O5: диалог доверия — уведомление, повторного запуска нет", () =>
  withRig(async (rig) => {
    await demo(rig);
    rig.tmux.scripts.set("demo-exec", { trust: true });
    await rig.step();
    rig.pass(2 * MINUTE);
    await rig.step();
    await rig.step();
    expect(rig.notices.notified).toStrictEqual([
      "demo exec: подтвердите доверие в окне demo-exec",
    ]);
    expect(launches(rig, "demo-exec").length).toBe(1);
  }));

it("O6: task положен, exec idle — /clear, Enter, сообщение, Enter", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.step();
    expect(rig.tmux.keys("demo-exec")).toStrictEqual([
      "/clear",
      ENTER,
      message("demo", "exec"),
      ENTER,
    ]);
    expect(nowOf(rig.letter("exec"))).toBe(
      "прочитай mpu task read project: demo и выполняй\n",
    );
    expect(rig.tmux.keys("demo-host")).toStrictEqual([]);
    assert(
      rig.letter("exec").includes(
        "\nВопрос хосту — mpu task question project: demo.\n",
      ),
    );
  }));

it("роль не ставит busy — три очистки, уведомление, роль остановлена", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    rig.tmux.scripts.set("demo-exec", { hangs: true });
    await rig.say("post", "x");
    for (let i = 0; i < 6; i++) {
      await rig.step();
      rig.pass(MINUTE + 1000);
    }
    const clears = rig.tmux.keys("demo-exec").filter((key) => key === "/clear");
    expect(clears.length).toBe(3);
    expect(rig.notices.notified).toStrictEqual([
      "demo exec: не будится (3 попытки) — вернуть: systemctl --user restart mpu",
    ]);
  }));

it("после /clear роль не освободилась за 60 с — повтор, третий — уведомление", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    rig.tmux.scripts.set("demo-exec", { stuck: true });
    await rig.say("post", "x");
    await rig.step();
    expect(rig.tmux.keys("demo-exec")).toStrictEqual(["/clear", ENTER]);
    for (let i = 0; i < 5; i++) {
      rig.pass(MINUTE + 1000);
      await rig.step();
    }
    const keys = rig.tmux.keys("demo-exec");
    expect(keys.filter((key) => key === "/clear").length).toBe(3);
    expect(keys.includes(message("demo", "exec"))).toBe(false);
    expect(rig.notices.notified).toStrictEqual([
      "demo exec: не будится (3 попытки) — вернуть: systemctl --user restart mpu",
    ]);
  }));

it("O5: диалог доверия, окно закрыли — следующий шаг запускает снова", () =>
  withRig(async (rig) => {
    await demo(rig);
    rig.tmux.scripts.set("demo-exec", { trust: true });
    await rig.step();
    rig.tmux.kill("demo-exec");
    rig.tmux.scripts.delete("demo-exec");
    await rig.step();
    await rig.step();
    expect(launches(rig, "demo-exec").length).toBe(2);
    expect(rig.tmux.panes.get("w:demo-exec")?.command).toBe("claude");
  }));

it("шаг проекта упал — строка лога, соседний проект шагает", () =>
  withRig(async (rig) => {
    await demo(rig);
    await rig.stand.human("ask", "task", "setup", "project:", "other");
    await rig.profile("host", "other");
    await rig.profile("exec", "other");
    await settled(rig);
    await settled(rig, "other");
    await rig.say("post", "x");
    await rig.say("post", "y", "other");
    const screen = rig.tmux.screen.bind(rig.tmux);
    rig.tmux.screen = (place) =>
      place.window === "demo-exec"
        ? Promise.reject(new Error("tmux: нет панели"))
        : screen(place);
    await rig.step();
    expect(rig.notices.logged).toStrictEqual(["demo: шаг: tmux: нет панели"]);
    expect(rig.notices.notified).toStrictEqual([]);
    expect(rig.tmux.keys("other-exec")[0]).toBe("/clear");
  }));

it("O7: task положен, exec busy — ни одного нажатия", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.say("post", "x");
    await rig.step();
    expect(rig.tmux.keys("demo-exec")).toStrictEqual([]);
  }));

it("O8: report не прочитан, host idle — очистка хоста", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.say("post", "x");
    await rig.say("report", "готово");
    await rig.step();
    expect(rig.tmux.keys("demo-host")).toStrictEqual([
      "/clear",
      ENTER,
      message("demo", "host"),
      ENTER,
    ]);
    expect(nowOf(rig.letter("host"))).toStrictEqual(
      "прими порцию 1 по отчёту; спека и постановка 2 по плану; " +
        "положи mpu task post project: demo\n",
    );
    assert(
      rig.letter("host").includes(
        "\nВопрос владельцу — mpu task owner project: demo.\n",
      ),
    );
  }));

it("O9: question не отвечен, host busy — нажатий нет", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.mark("host", "busy");
    await rig.say("post", "x");
    await rig.say("question", "почему?");
    await rig.step();
    expect(rig.tmux.keys("demo-host")).toStrictEqual([]);
  }));

it("O9: question не отвечен, host idle — вопрос в первом сообщении", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.say("post", "x");
    await rig.say("question", "почему?");
    await rig.step();
    expect(nowOf(rig.letter("host"))).toStrictEqual(
      "ответь на вопрос исполнителя по порции 1: почему? — " +
        "ответ: mpu task answer project: demo\n",
    );
  }));

it("O10: окно exec умерло при busy — новое окно, строка продолжения", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    rig.tmux.kill("demo-exec");
    await rig.step();
    expect(launches(rig, "demo-exec").length).toBe(1);
    expect(nowOf(rig.letter("exec"))).toStrictEqual(`${RESUME_LINE}\n`);
  }));

it("O11: баннер Sonnet при профиле opus — окно закрыто без /model, запуск с --model opus", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    rig.tmux.alive("demo-exec", "sonnet");
    await rig.step();
    expect(rig.tmux.keys("demo-exec")).toStrictEqual([]);
    expect(rig.tmux.panes.has("w:demo-exec")).toBe(false);
    await rig.step();
    const [line] = launches(rig, "demo-exec");
    expect(shellWords(line).slice(-4)).toStrictEqual([
      "--model",
      "opus",
      "--name",
      "demo-exec",
    ]);
    expect(rig.tmux.keys("demo-exec").filter((key) => key.startsWith("/model")))
      .toStrictEqual([]);
  }));

it("O11b: баннер Opus, в тексте роли sonnet — ничего", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    rig.tmux.print(
      "demo-exec",
      "⏺ Роль exec работает на sonnet, хост — на opus.",
      "  sonnet",
    );
    await rig.step();
    await rig.step();
    expect(rig.tmux.keys("demo-exec")).toStrictEqual([]);
    expect(rig.tmux.panes.has("w:demo-exec")).toBe(true);
  }));

it("O12: exec busy, журнал не менялся 61 мин — одно уведомление, очистки нет", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.mark("exec", "busy");
    rig.pass(61 * MINUTE);
    await rig.step();
    await rig.step();
    rig.pass(MINUTE);
    await rig.step();
    expect(rig.notices.notified).toStrictEqual([
      "demo exec: занят больше часа без движения",
    ]);
    expect(rig.tmux.keys("demo-exec")).toStrictEqual([]);
  }));

it("O12: час не прошёл — молча", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    rig.pass(59 * MINUTE);
    await rig.step();
    expect(rig.notices.notified).toStrictEqual([]);
  }));

it("O13: owner без ответа 61 мин — одно уведомление", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.say("owner", "нужен ли y?");
    rig.pass(61 * MINUTE);
    await rig.mark("exec", "busy");
    await rig.step();
    await rig.step();
    expect(rig.notices.notified).toStrictEqual(["demo: ждёт ответа владельца"]);
  }));

it("O14: stop — окна не трогаются; resume — шаги идут", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.say("stop", "^нет ключа^");
    rig.tmux.kill("demo-host");
    await rig.step();
    await rig.step();
    expect(rig.tmux.keys("demo-exec")).toStrictEqual([]);
    expect(launches(rig, "demo-host")).toStrictEqual([]);
    expect(rig.notices.notified).toStrictEqual([
      "demo: остановлен — нет ключа",
    ]);
    const run = await rig.stand.human(
      "ask",
      "task",
      "resume",
      "project:",
      "demo",
    );
    expect(run.code, run.stderr).toBe(0);
    await rig.step();
    expect(rig.tmux.keys("demo-exec")[0]).toBe("/clear");
    expect(launches(rig, "demo-host").length).toBe(1);
  }));

it("O15: два проекта — у каждого своё окно и свой файл", () =>
  withRig(async (rig) => {
    await demo(rig);
    await rig.stand.human("ask", "task", "setup", "project:", "other");
    await rig.profile("host", "other");
    await rig.profile("exec", "other");
    await settled(rig);
    await settled(rig, "other");
    await rig.say("post", "x");
    await rig.say("post", "y", "other");
    await rig.step();
    for (const project of ["demo", "other"]) {
      expect(rig.tmux.keys(`${project}-exec`)[2]).toStrictEqual(
        message(project, "exec"),
      );
      expect(nowOf(rig.letter("exec", project))).toStrictEqual(
        `прочитай mpu task read project: ${project} и выполняй\n`,
      );
    }
  }));

it("O16: task.max_busy = 1 — очищен один, второй после idle первого", () =>
  withRig(async (rig) => {
    await demo(rig);
    await rig.stand.human("ask", "task", "setup", "project:", "other");
    await rig.profile("host", "other");
    await rig.profile("exec", "other");
    rig.stand.openDb().execute(
      "INSERT INTO config (key, value) VALUES ('task.max_busy', '1')",
    );
    await settled(rig);
    await settled(rig, "other");
    await rig.say("post", "x");
    await rig.say("post", "y", "other");
    await rig.step();
    expect(rig.tmux.keys("demo-exec")[0]).toBe("/clear");
    expect(rig.tmux.keys("other-exec")).toStrictEqual([]);
    await rig.step();
    expect(rig.tmux.keys("other-exec")).toStrictEqual([]);
    await rig.mark("exec", "idle");
    await rig.step();
    expect(rig.tmux.keys("other-exec")[0]).toBe("/clear");
  }));

it("O17: полномочия дословно и вывод decisions в первом сообщении", () =>
  withRig(async (rig) => {
    await rig.stand.human(
      "ask",
      "task",
      "setup",
      "project:",
      "demo",
    );
    await rig.profile("exec", "demo", "powers:", "^мерж", "—", "никогда^");
    await rig.say("post", "x");
    await rig.stand.human(
      "task",
      "rule",
      "project:",
      "demo",
      "text:",
      "^ревью — всегда^",
    );
    await rig.say("owner", "y?");
    await rig.stand.human(
      "task",
      "owner-answer",
      "project:",
      "demo",
      "text:",
      "да",
    );
    await rig.step();
    const decisions = await rig.stand.agent(
      "task",
      "decisions",
      "project:",
      "demo",
    );
    const letter = rig.letter("exec");
    assert(
      letter.startsWith("# Роль: exec проекта demo\n\nмерж — никогда\n"),
      letter,
    );
    assert(
      letter.endsWith(`## Правила и решения\n\n${decisions.stdout}`),
      letter,
    );
    assert(decisions.stdout.includes("ревью — всегда"), decisions.stdout);
  }));

it("O18: служба перезапущена посреди busy — окна живы, очисток нет", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.mark("exec", "busy");
    await rig.step();
    expect(rig.tmux.keys("demo-exec")).toStrictEqual([]);
    expect(rig.tmux.keys("demo-host")).toStrictEqual([]);
  }));
