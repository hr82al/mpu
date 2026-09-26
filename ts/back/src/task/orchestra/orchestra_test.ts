/**
 * Сценарии O1–O18 оркестратора (`task-orchestrator.md`, «Сценарии») на
 * стенде `teststage.ts`: поддельный tmux, поддельная роль, настоящий канал.
 */

import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { withStand } from "../teststand.ts";
import { RESUME_LINE } from "./letter.ts";
import { demo, ENTER, LETTER_DIR, Rig, shellWords } from "./teststage.ts";

const MINUTE = 60_000;

function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  return withStand(async (stand) => {
    using time = new FakeTime(Date.UTC(2026, 8, 26, 10));
    await body(new Rig(stand, time));
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

Deno.test("O1: окон нет — два окна, сообщение первым аргументом, Enter отдельно", () =>
  withRig(async (rig) => {
    await demo(rig);
    await rig.step();
    for (const role of ["host", "exec"]) {
      assertEquals(rig.tmux.keys(`demo-${role}`), [
        `claude "${
          message("demo", role)
        }" --permission-mode auto --model opus --name demo-${role}`,
        ENTER,
      ]);
      assertEquals(rig.tmux.panes.get(`w:demo-${role}`)?.command, "claude");
    }
    assertEquals(
      nowOf(rig.letter("exec")),
      "дела нет — жди: mpu task wait project: demo kind: task\n",
    );
    assertEquals(
      nowOf(rig.letter("host")),
      "дела нет — жди: mpu task wait project: demo kind: report\n",
    );
  }));

Deno.test("O2: add-dir — после --name, сообщение по-прежнему первым", () =>
  withRig(async (rig) => {
    await demo(rig, "add-dir:", "/tmp/a");
    await rig.step();
    const [line] = launches(rig, "demo-exec");
    assert(line.endsWith("--name demo-exec --add-dir /tmp/a"), line);
    assertEquals(shellWords(line)[1], message("demo", "exec"));
  }));

Deno.test("O3: сессии нет — создана, окно в ней", () =>
  withRig(async (rig) => {
    await demo(rig, "session:", "a");
    await rig.step();
    assert(rig.tmux.sessions.has("a"));
    assertEquals(rig.tmux.panes.get("a:demo-exec")?.command, "claude");
    assertEquals(launches(rig, "demo-exec"), []);
    assertEquals(rig.tmux.keys("demo-exec", "a").length, 2);
  }));

Deno.test("O4: роль не печатает ❯ — после третьего запуска остановлена, одно уведомление", () =>
  withRig(async (rig) => {
    await demo(rig);
    rig.tmux.scripts.set("demo-exec", { silent: true });
    for (let i = 0; i < 6; i++) {
      await rig.step();
      rig.pass(MINUTE + 1000);
    }
    assertEquals(launches(rig, "demo-exec").length, 3);
    const halted =
      "demo exec: не запускается (3 попытки) — вернуть: systemctl --user restart mpu";
    assertEquals(rig.notices.notified, [halted]);
    assertEquals(rig.notices.logged, [halted]);
    await rig.step();
    await rig.step();
    assertEquals(launches(rig, "demo-exec").length, 3);
    assertEquals(launches(rig, "demo-host").length, 1);
  }));

Deno.test("O5: диалог доверия — уведомление, повторного запуска нет", () =>
  withRig(async (rig) => {
    await demo(rig);
    rig.tmux.scripts.set("demo-exec", { trust: true });
    await rig.step();
    rig.pass(2 * MINUTE);
    await rig.step();
    await rig.step();
    assertEquals(rig.notices.notified, [
      "demo exec: подтвердите доверие в окне demo-exec",
    ]);
    assertEquals(launches(rig, "demo-exec").length, 1);
  }));

Deno.test("O6: task положен, exec idle — /clear, Enter, сообщение, Enter", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.step();
    assertEquals(rig.tmux.keys("demo-exec"), [
      "/clear",
      ENTER,
      message("demo", "exec"),
      ENTER,
    ]);
    assertEquals(
      nowOf(rig.letter("exec")),
      "прочитай mpu task read project: demo и выполняй\n",
    );
    assertEquals(rig.tmux.keys("demo-host"), []);
  }));

Deno.test("роль не ставит busy — три очистки, уведомление, роль остановлена", () =>
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
    assertEquals(clears.length, 3);
    assertEquals(rig.notices.notified, [
      "demo exec: не будится (3 попытки) — вернуть: systemctl --user restart mpu",
    ]);
  }));

Deno.test("после /clear роль не освободилась за 60 с — повтор, третий — уведомление", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    rig.tmux.scripts.set("demo-exec", { stuck: true });
    await rig.say("post", "x");
    await rig.step();
    assertEquals(rig.tmux.keys("demo-exec"), ["/clear", ENTER]);
    for (let i = 0; i < 5; i++) {
      rig.pass(MINUTE + 1000);
      await rig.step();
    }
    const keys = rig.tmux.keys("demo-exec");
    assertEquals(keys.filter((key) => key === "/clear").length, 3);
    assertEquals(keys.includes(message("demo", "exec")), false);
    assertEquals(rig.notices.notified, [
      "demo exec: не будится (3 попытки) — вернуть: systemctl --user restart mpu",
    ]);
  }));

Deno.test("O5: диалог доверия, окно закрыли — следующий шаг запускает снова", () =>
  withRig(async (rig) => {
    await demo(rig);
    rig.tmux.scripts.set("demo-exec", { trust: true });
    await rig.step();
    rig.tmux.kill("demo-exec");
    rig.tmux.scripts.delete("demo-exec");
    await rig.step();
    await rig.step();
    assertEquals(launches(rig, "demo-exec").length, 2);
    assertEquals(rig.tmux.panes.get("w:demo-exec")?.command, "claude");
  }));

Deno.test("шаг проекта упал — строка лога, соседний проект шагает", () =>
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
    assertEquals(rig.notices.logged, ["demo: шаг: tmux: нет панели"]);
    assertEquals(rig.notices.notified, []);
    assertEquals(rig.tmux.keys("other-exec")[0], "/clear");
  }));

Deno.test("O7: task положен, exec busy — ни одного нажатия", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.say("post", "x");
    await rig.step();
    assertEquals(rig.tmux.keys("demo-exec"), []);
  }));

Deno.test("O8: report не прочитан, host idle — очистка хоста", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.say("post", "x");
    await rig.say("report", "готово");
    await rig.step();
    assertEquals(rig.tmux.keys("demo-host"), [
      "/clear",
      ENTER,
      message("demo", "host"),
      ENTER,
    ]);
    assertEquals(
      nowOf(rig.letter("host")),
      "прими порцию 1 по отчёту; спека и постановка 2 по плану; " +
        "положи mpu task post project: demo\n",
    );
  }));

Deno.test("O9: question не отвечен, host busy — нажатий нет", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.mark("host", "busy");
    await rig.say("post", "x");
    await rig.say("question", "почему?");
    await rig.step();
    assertEquals(rig.tmux.keys("demo-host"), []);
  }));

Deno.test("O9: question не отвечен, host idle — вопрос в первом сообщении", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    await rig.say("post", "x");
    await rig.say("question", "почему?");
    await rig.step();
    assertEquals(
      nowOf(rig.letter("host")),
      "ответь на вопрос исполнителя по порции 1: почему? — " +
        "ответ: mpu task answer project: demo\n",
    );
  }));

Deno.test("O10: окно exec умерло при busy — новое окно, строка продолжения", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    rig.tmux.kill("demo-exec");
    await rig.step();
    assertEquals(launches(rig, "demo-exec").length, 1);
    assertEquals(nowOf(rig.letter("exec")), `${RESUME_LINE}\n`);
  }));

Deno.test("O11: модель sonnet при профиле opus — /model, закрыть, запуск с --model opus", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    rig.tmux.alive("demo-exec", "sonnet");
    rig.tmux.scripts.set("demo-exec", { model: "sonnet" });
    await rig.step();
    assertEquals(rig.tmux.keys("demo-exec"), ["/model opus", ENTER]);
    await rig.step();
    assertEquals(rig.tmux.panes.has("w:demo-exec"), false);
    await rig.step();
    const [line] = launches(rig, "demo-exec");
    assertEquals(shellWords(line).slice(-4), [
      "--model",
      "opus",
      "--name",
      "demo-exec",
    ]);
  }));

Deno.test("O12: exec busy, журнал не менялся 61 мин — одно уведомление, очистки нет", () =>
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
    assertEquals(rig.notices.notified, [
      "demo exec: занят больше часа без движения",
    ]);
    assertEquals(rig.tmux.keys("demo-exec"), []);
  }));

Deno.test("O12: час не прошёл — молча", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.mark("exec", "busy");
    rig.pass(59 * MINUTE);
    await rig.step();
    assertEquals(rig.notices.notified, []);
  }));

Deno.test("O13: owner без ответа 61 мин — одно уведомление", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.say("owner", "нужен ли y?");
    rig.pass(61 * MINUTE);
    await rig.mark("exec", "busy");
    await rig.step();
    await rig.step();
    assertEquals(rig.notices.notified, ["demo: ждёт ответа владельца"]);
  }));

Deno.test("O14: stop — окна не трогаются; resume — шаги идут", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.say("stop", "^нет ключа^");
    rig.tmux.kill("demo-host");
    await rig.step();
    await rig.step();
    assertEquals(rig.tmux.keys("demo-exec"), []);
    assertEquals(launches(rig, "demo-host"), []);
    assertEquals(rig.notices.notified, ["demo: остановлен — нет ключа"]);
    const run = await rig.stand.human(
      "ask",
      "task",
      "resume",
      "project:",
      "demo",
    );
    assertEquals(run.code, 0, run.stderr);
    await rig.step();
    assertEquals(rig.tmux.keys("demo-exec")[0], "/clear");
    assertEquals(launches(rig, "demo-host").length, 1);
  }));

Deno.test("O15: два проекта — у каждого своё окно и свой файл", () =>
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
      assertEquals(
        rig.tmux.keys(`${project}-exec`)[2],
        message(project, "exec"),
      );
      assertEquals(
        nowOf(rig.letter("exec", project)),
        `прочитай mpu task read project: ${project} и выполняй\n`,
      );
    }
  }));

Deno.test("O16: task.max_busy = 1 — очищен один, второй после idle первого", () =>
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
    assertEquals(rig.tmux.keys("demo-exec")[0], "/clear");
    assertEquals(rig.tmux.keys("other-exec"), []);
    await rig.step();
    assertEquals(rig.tmux.keys("other-exec"), []);
    await rig.mark("exec", "idle");
    await rig.step();
    assertEquals(rig.tmux.keys("other-exec")[0], "/clear");
  }));

Deno.test("O17: полномочия дословно и вывод decisions в первом сообщении", () =>
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

Deno.test("O18: служба перезапущена посреди busy — окна живы, очисток нет", () =>
  withRig(async (rig) => {
    await demo(rig);
    await settled(rig);
    await rig.say("post", "x");
    await rig.mark("exec", "busy");
    await rig.step();
    assertEquals(rig.tmux.keys("demo-exec"), []);
    assertEquals(rig.tmux.keys("demo-host"), []);
  }));
