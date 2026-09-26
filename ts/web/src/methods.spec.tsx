/**
 * Методы образа на экране «Правила» (`web-image.md`, сценарии 1–12,
 * 23–25): узел метода с полями образа, правка ровно `image.definition`,
 * удаление, ответ строки под полем, протокол корня, строка правила с `--`
 * у любого узла. Эталоны — ответы стенда «три метода».
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { NodeRuling, Snapshot } from "./api.ts";
import { Rules } from "./Rules.tsx";
import {
  POLICY_TREE_IMAGE,
  reads,
  renderWith,
  scripted,
  sentLines,
  SNAPSHOT_IMAGE,
} from "./testkit.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const DEFINITION =
  "kiten define: cardsIn: purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done";
const WORDS = [
  "ask",
  "kiten",
  "define:",
  "cardsIn:",
  "purpose:",
  "^мои",
  "в",
  "колонке^",
  "keys:",
  "^id",
  "колонки^",
  "do",
  ":col",
  "kiten",
  "ls",
  "where:",
  "column",
  "is:",
  "@col",
  "done",
];
const EDITED = DEFINITION.replace(
  "do :col kiten ls where: column is: @col done",
  "do :c kiten ls where: column is: @c done",
);
const DEFINED = {
  stdout: '{"path":"kiten cardsIn:","verdict":"allow"}\n',
  stderr: "",
  exit: 0,
};

const question = (ask: string) => ({
  stdout: "",
  stderr: "",
  ask,
  ticket: "0123456789abcdef0123456789abcdef",
});

const refused = (text: string, reason: string, exit: number) => ({
  stdout: "",
  stderr: `${text}\n`,
  refusal: { reason, hint: null, candidates: [], text },
  exit,
});

/** Строка узла по пути. */
function row(path: string): HTMLElement {
  const found = screen.getByText(path, { selector: ".path" });
  return found.closest("li") as HTMLElement;
}

/** Экран, раскрытый до `kiten`. */
async function opened(back: ReturnType<typeof scripted>) {
  renderWith(back.transport, <Rules />);
  await screen.findByText("kiten", { selector: ".path" });
  fireEvent.click(screen.getByRole("button", { name: "раскрыть kiten" }));
}

function field(): HTMLTextAreaElement {
  return screen.getByLabelText("Определение kiten cardsIn:");
}

function panel(): HTMLElement {
  return field().closest(".method") as HTMLElement;
}

describe("узел метода", () => {
  test("1: три метода под kiten, поля образа, поле правки = definition", async () => {
    await opened(scripted([]));
    for (const path of ["kiten cardsIn:", "kiten mine", "kiten shipped"]) {
      expect(within(row(path)).getByText("образ", { selector: ".label" }))
        .toBeTruthy();
    }
    const node = row("kiten cardsIn:").querySelector(".node") as HTMLElement;
    expect(within(node).getByText("образ: мои в колонке")).toBeTruthy();
    expect(within(node).getByText("allow", { selector: ".verdict" }))
      .toBeTruthy();
    expect(within(node).getByText("правило «kiten cardsIn:»")).toBeTruthy();
    expect(within(node).getByText("своё")).toBeTruthy();
    expect(
      within(node).getByRole("button", { name: "сбросить kiten cardsIn:" }),
    )
      .toBeTruthy();
    expect(within(panel()).getByText("human")).toBeTruthy();
    expect(within(panel()).getByText("2026-09-23T10:00:00.000Z")).toBeTruthy();
    expect(
      within(panel()).getByText(
        "do :col kiten ls where: column is: @col done",
        {
          selector: "code",
        },
      ),
    ).toBeTruthy();
    expect(field().value).toBe(DEFINITION);
  });

  test("2: у команды полей образа, правки и «Удалить метод» нет", async () => {
    await opened(scripted([]));
    const ls = row("kiten ls");
    expect(ls.querySelector(".method")).toBeNull();
    expect(within(ls).queryByText("образ", { selector: ".label" })).toBeNull();
    expect(within(ls).queryByRole("button", { name: "Удалить метод" }))
      .toBeNull();
  });

  test("12: протокол корня — один блок, семь строк", async () => {
    await opened(scripted([]));
    const blocks = screen.getAllByRole("region", {
      name: "понимает любой объект",
    });
    expect(blocks.length).toBe(1);
    const lines = within(blocks[0]).getAllByRole("listitem");
    expect(lines.map((one) => one.textContent)).toEqual(
      SNAPSHOT_IMAGE.protocol.map((one) => `${one.selector} — ${one.purpose}`),
    );
    expect(lines.length).toBe(7);
    expect(row("kiten").querySelector("[aria-label='понимает любой объект']"))
      .toBeNull();
  });
});

describe("правка определения", () => {
  test("3–4: «Сохранить» без правки — слова поля, окно, «Да», дерево перечитано", async () => {
    const back = scripted([
      question(`выполнить mpu ${DEFINITION}? [y/N] `),
      DEFINED,
    ]);
    await opened(back);
    fireEvent.click(within(panel()).getByRole("button", { name: "Сохранить" }));
    const dialog = await screen.findByRole("dialog");
    expect(sentLines(back.seen)).toEqual([WORDS]);
    expect(dialog.textContent).toContain(
      `выполнить mpu ${DEFINITION}? [y/N]`,
    );
    const before = [
      reads(back.seen, "policy.tree"),
      reads(back.seen, "tree.snapshot"),
    ];
    fireEvent.click(within(dialog).getByRole("button", { name: "Да" }));
    await waitFor(() =>
      expect([
        reads(back.seen, "policy.tree") > before[0],
        reads(back.seen, "tree.snapshot") > before[1],
      ]).toEqual([true, true])
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("5–6: правленое тело — окно с ним; «Нет» — отказ под полем, текст цел", async () => {
    const text = `mpu ${EDITED}: не подтверждено`;
    const back = scripted([
      question(`выполнить mpu ${EDITED}? [y/N] `),
      refused(text, "не подтверждено", 1),
    ]);
    await opened(back);
    fireEvent.change(field(), { target: { value: EDITED } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Сохранить" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(`выполнить mpu ${EDITED}? [y/N]`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Нет" }));
    expect(await within(panel()).findByText(text)).toBeTruthy();
    expect(field().value).toBe(EDITED);
  });

  test("7: без назначения — окна нет, отказ под полем, поле не сброшено", async () => {
    const text = "mpu kiten define: метод без назначения: purpose: ^…^";
    const back = scripted([refused(text, "метод без назначения", 2)]);
    await opened(back);
    const edited = DEFINITION.replace(" purpose: ^мои в колонке^", "");
    fireEvent.change(field(), { target: { value: edited } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Сохранить" }));
    expect(await within(panel()).findByText(text)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(field().value).toBe(edited);
  });

  test("8: другое имя — новый узел, прежний на месте", async () => {
    let shot: Snapshot = SNAPSHOT_IMAGE;
    let tree: readonly NodeRuling[] = POLICY_TREE_IMAGE;
    const renamed = DEFINITION.replace("cardsIn:", "cardsOf:");
    const back = scripted([
      question(`выполнить mpu ${renamed}? [y/N] `),
      { ...DEFINED, stdout: '{"path":"kiten cardsOf:","verdict":"allow"}\n' },
    ], () => ({ tree, shot }));
    await opened(back);
    fireEvent.change(field(), { target: { value: renamed } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Сохранить" }));
    const dialog = await screen.findByRole("dialog");
    const cardsIn = SNAPSHOT_IMAGE.nodes.find((one) =>
      one.path.join(" ") === "kiten cardsIn:"
    );
    shot = {
      ...SNAPSHOT_IMAGE,
      nodes: [...SNAPSHOT_IMAGE.nodes, {
        path: ["kiten", "cardsOf:"],
        summary: "образ: мои в колонке",
        ...(cardsIn?.image === undefined ? {} : {
          image: { ...cardsIn.image, definition: renamed },
        }),
      }],
    };
    tree = [...POLICY_TREE_IMAGE, {
      path: ["kiten", "cardsOf:"],
      verdict: "allow",
      rule: "kiten cardsOf:",
      own: true,
    }];
    fireEvent.click(within(dialog).getByRole("button", { name: "Да" }));
    expect(await screen.findByText("kiten cardsOf:", { selector: ".path" }))
      .toBeTruthy();
    expect(screen.getByText("kiten cardsIn:", { selector: ".path" }))
      .toBeTruthy();
  });

  test("9: вопроса нет — окна нет, дерево перечитано", async () => {
    const back = scripted([DEFINED]);
    await opened(back);
    const before = reads(back.seen, "tree.snapshot");
    fireEvent.click(within(panel()).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(reads(back.seen, "tree.snapshot")).toBeGreaterThan(before)
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("слова поля — по правилу «Текст → слова»: табуляция, \\r\\n; U+00A0 — часть слова", async () => {
    const back = scripted([DEFINED]);
    await opened(back);
    fireEvent.change(field(), {
      target: { value: "kiten\tdefine:\r\ncardsIn: purpose: ^а б^  do done" },
    });
    fireEvent.click(within(panel()).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(sentLines(back.seen).length).toBe(1));
    expect(sentLines(back.seen)).toEqual([[
      "ask",
      "kiten",
      "define:",
      "cardsIn:",
      "purpose:",
      "^а б^",
      "do",
      "done",
    ]]);
  });
});

describe("удаление метода", () => {
  test("10: forget: последним звеном пути, окно, узла нет", async () => {
    let gone = false;
    const without = (path: readonly string[]) =>
      path.join(" ") !== "kiten cardsIn:";
    const back = scripted([
      question("выполнить mpu kiten forget: cardsIn:? [y/N] "),
      {
        stdout: '{"path":"kiten cardsIn:","verdict":null}\n',
        stderr: "",
        exit: 0,
      },
    ], () =>
      gone
        ? {
          tree: POLICY_TREE_IMAGE.filter((one) => without(one.path)),
          shot: {
            ...SNAPSHOT_IMAGE,
            nodes: SNAPSHOT_IMAGE.nodes.filter((one) => without(one.path)),
          },
        }
        : { tree: POLICY_TREE_IMAGE, shot: SNAPSHOT_IMAGE });
    await opened(back);
    fireEvent.click(
      within(panel()).getByRole("button", { name: "Удалить метод" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(sentLines(back.seen)).toEqual([[
      "ask",
      "kiten",
      "forget:",
      "cardsIn:",
    ]]);
    expect(dialog.textContent).toContain(
      "выполнить mpu kiten forget: cardsIn:? [y/N]",
    );
    gone = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Да" }));
    await waitFor(() =>
      expect(screen.queryByText("kiten cardsIn:", { selector: ".path" }))
        .toBeNull()
    );
  });

  test("11: запрещено правилом — окна нет, отказ под полем, узел на месте", async () => {
    const text =
      "mpu kiten forget: cardsIn:: запрещено правилом «kiten forget:»";
    const back = scripted([refused(text, "запрещено правилом", 1)]);
    await opened(back);
    fireEvent.click(
      within(panel()).getByRole("button", { name: "Удалить метод" }),
    );
    expect(await within(panel()).findByText(text)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("kiten cardsIn:", { selector: ".path" }))
      .toBeTruthy();
  });
});

describe("строка правила на узле", () => {
  const cases = [
    {
      name: "23: deny на узле метода",
      button: "deny для kiten cardsIn:",
      words: ["deny:", "--", "kiten cardsIn:"],
      ask: "изменить правило: kiten cardsIn: → deny? [y/N] ",
    },
    {
      name: "24: «сбросить» на узле метода",
      button: "сбросить kiten cardsIn:",
      words: ["forget:", "--", "kiten cardsIn:"],
      ask: "изменить правило: kiten cardsIn: → forget? [y/N] ",
    },
    {
      name: "25: allow на группе — та же форма",
      button: "allow для kiten",
      words: ["allow:", "--", "kiten"],
      ask: "изменить правило: kiten → allow? [y/N] ",
    },
  ];
  for (const one of cases) {
    test(one.name, async () => {
      const back = scripted([question(one.ask)]);
      await opened(back);
      fireEvent.click(screen.getByRole("button", { name: one.button }));
      const dialog = await screen.findByRole("dialog");
      expect(sentLines(back.seen)).toEqual([one.words]);
      expect(dialog.textContent).toContain(one.ask.trimEnd());
    });
  }
});
