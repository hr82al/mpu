/**
 * Окно tmux в заголовке (`claude-hook-permission-request.md` [D.4]):
 * сокет — часть `TMUX` клиента до запятой, панель — `TMUX_PANE`; нет
 * одного из них или tmux молчит — места нет.
 */

import { describe, expect, it } from "vitest";
import { type CallerEnv, type TmuxRun, Windows } from "./window.ts";

/** tmux, запоминающий аргументы и отвечающий `said`. */
function tmux(said: string | undefined) {
  const calls: (readonly string[])[] = [];
  const run: TmuxRun = (args) => {
    calls.push(args);
    return Promise.resolve(said);
  };
  return { calls, run };
}

function env(values: Readonly<Record<string, string>>): CallerEnv {
  return (name) => values[name];
}

it("подпись окна: сокет до запятой, панель клиента, формат #S:#I #W", async () => {
  const { calls, run } = tmux("w:4 probe\n");
  const caption = await new Windows(run).captionOf(
    env({ TMUX: "/tmp/tmux-1000/default,4242,0", TMUX_PANE: "%3" }),
  );
  expect(caption).toStrictEqual(["w:4 probe"]);
  expect(calls).toStrictEqual([[
    "-S",
    "/tmp/tmux-1000/default",
    "display-message",
    "-p",
    "-t",
    "%3",
    "#S:#I #W",
  ]]);
});

describe("нет TMUX, нет TMUX_PANE, tmux молчит — места нет", () => {
  const cases: readonly [
    string,
    Readonly<Record<string, string>>,
    string | undefined,
  ][] = [
    ["нет TMUX", { TMUX_PANE: "%3" }, "w:1 a"],
    ["нет TMUX_PANE", { TMUX: "/s,1,0" }, "w:1 a"],
    ["tmux не ответил", { TMUX: "/s,1,0", TMUX_PANE: "%3" }, undefined],
    ["пустой ответ", { TMUX: "/s,1,0", TMUX_PANE: "%3" }, "\n"],
  ];
  for (const [name, values, said] of cases) {
    it(
      name,
      async () =>
        expect(await new Windows(tmux(said).run).captionOf(env(values)))
          .toStrictEqual([]),
    );
  }
});
