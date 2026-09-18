/**
 * Экран «Правила» (`specs/web.md`, 10b): состояния «нет сессии» и
 * «back недоступен», дерево из ответов сервера, изменение правила с
 * подтверждением, доступность окна, вход по ключу.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { NodeRuling } from "./api.ts";
import { Rules } from "./Rules.tsx";
import { enter } from "./session.ts";
import {
  fakeBack,
  json,
  POLICY_TREE,
  renderWith,
  rpcAnswer,
  type Seen,
} from "./testkit.tsx";
import { buildTree } from "./tree.ts";
import { SNAPSHOT } from "./testkit.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("вход по ключу", () => {
  test("ключ меняется на сессию и убирается из адреса", async () => {
    const back = fakeBack(() => new Response(null, { status: 204 }));
    const replaced: string[] = [];
    await enter({
      href:
        "http://mpu.localhost:7338/?key=0123456789abcdef0123456789abcdef&x=1",
      replace: (url) => void replaced.push(url),
    }, back.transport);
    expect(back.seen).toEqual([{
      path: "/web/session",
      body: { key: "0123456789abcdef0123456789abcdef" },
      accept: null,
    }]);
    expect(replaced).toEqual(["/?x=1"]);
  });

  test("ключа нет — ни обмена, ни правки адреса", async () => {
    const back = fakeBack(() => new Response(null, { status: 204 }));
    const replaced: string[] = [];
    await enter({
      href: "http://mpu.localhost:7338/",
      replace: (url) => void replaced.push(url),
    }, back.transport);
    expect([back.seen, replaced]).toEqual([[], []]);
  });
});

describe("состояния экрана", () => {
  test("401 — просьба открыть ссылку, дерева нет", async () => {
    const back = fakeBack(() => json({}, 401));
    renderWith(back.transport, <Rules />);
    expect(await screen.findByText(/Откройте ссылку из/)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("back недоступен — адрес и «Повторить», пустого дерева нет", async () => {
    let up = false;
    const back = fakeBack((seen) => up ? rpcAnswer()(seen) : undefined);
    renderWith(back.transport, <Rules />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "mpu-back недоступен на http://mpu.localhost:7338",
    );
    expect(screen.queryByRole("list")).toBeNull();
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Правила подтверждения")).toBeTruthy();
  });
  test("200 с мусором вместо JSON — «недоступен», а не вечная загрузка", async () => {
    const back = fakeBack(() => new Response("<html>прокси</html>"));
    renderWith(back.transport, <Rules />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "mpu-back недоступен на http://mpu.localhost:7338",
    );
  });
});

describe("дерево", () => {
  test("свёрнуто до первого уровня; путь, назначение, решение, откуда, своё", async () => {
    const back = fakeBack(rpcAnswer());
    renderWith(back.transport, <Rules />);
    const kiten = await screen.findByText("kiten", { selector: ".path" });
    const row = kiten.closest(".node") as HTMLElement;
    expect(within(row).getByText("ask", { selector: ".verdict" })).toBeTruthy();
    expect(within(row).getByText("правило «kiten»")).toBeTruthy();
    expect(within(row).getByText("своё")).toBeTruthy();
    expect(within(row).getByText(/карточки Kaiten/)).toBeTruthy();
    // Второй уровень свёрнут.
    expect(screen.queryByText("kiten card", { selector: ".path" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "раскрыть kiten" }));
    expect(screen.getByText("kiten card", { selector: ".path" })).toBeTruthy();
  });

  test("решение — с сервера, даже если «наивно» по правилам вышло бы иначе", async () => {
    // Корень deny, а у sql-ro сервер прислал allow без своего правила:
    // фронт показывает присланное, а не выводит deny от «*».
    const tree: NodeRuling[] = POLICY_TREE.map((node) =>
      node.path.join(" ") === "sql-ro"
        ? { ...node, verdict: "allow", rule: "*", own: false }
        : node
    );
    const back = fakeBack(rpcAnswer(tree));
    renderWith(back.transport, <Rules />);
    const sql = await screen.findByText("sql-ro", { selector: ".path" });
    const row = sql.closest(".node") as HTMLElement;
    expect(within(row).getByText("allow", { selector: ".verdict" }))
      .toBeTruthy();
  });

  test("rule: null — «по умолчанию: ask»; смешанно у родителя", () => {
    const tree = buildTree([
      { path: [], verdict: "ask", rule: null, own: false },
      { path: ["a"], verdict: "ask", rule: null, own: false },
      { path: ["a", "x"], verdict: "allow", rule: "a x", own: true },
      { path: ["a", "y"], verdict: "deny", rule: "a y", own: true },
    ], SNAPSHOT);
    expect(tree?.children[0].rule).toBeNull();
    expect(tree?.children[0].mixed).toBe(true);
    expect(tree?.children[0].children[0].mixed).toBe(false);
  });

  test("поиск по пути фильтрует дерево и раскрывает найденное", async () => {
    const back = fakeBack(rpcAnswer());
    renderWith(back.transport, <Rules />);
    await screen.findByText("kiten", { selector: ".path" });
    fireEvent.change(screen.getByLabelText(/Поиск по пути/), {
      target: { value: "card" },
    });
    expect(screen.getByText("kiten card", { selector: ".path" })).toBeTruthy();
    expect(screen.queryByText("sql-ro", { selector: ".path" })).toBeNull();
  });
});

/** Эталонное дерево, где у `kiten` действует `deny` своим правилом. */
const DENIED: NodeRuling[] = POLICY_TREE.map((node) =>
  node.path.join(" ") === "kiten"
    ? { ...node, verdict: "deny", rule: "kiten", own: true }
    : node
);

/**
 * `back`, который на строку правила отвечает вопросом с номером; после
 * «y» `policy.tree` отдаёт дерево с `deny` у `kiten`.
 */
function asking() {
  let reads = 0;
  let base = rpcAnswer();
  const back = fakeBack((seen: Seen) => {
    if (seen.path === "/rpc" && seen.body.method === "policy.tree") reads += 1;
    if (seen.path === "/line") {
      return json({
        stdout: "",
        stderr: "",
        ask: "изменить правило: kiten → deny? [y/N] ",
        ticket: "0123456789abcdef0123456789abcdef",
      });
    }
    if (seen.path === "/line/answer") {
      const yes = seen.body.answer === "y";
      if (yes) base = rpcAnswer(DENIED);
      return json({
        stdout: "",
        stderr: yes ? "" : "mpu deny: kiten: не подтверждено\n",
        exit: yes ? 0 : 1,
      });
    }
    return base(seen);
  });
  return { ...back, reads: () => reads };
}

/** Решение, показанное в строке узла. */
function verdictOf(path: string): string | null {
  const row = screen.getByText(path, { selector: ".path" }).closest(".node");
  return row?.querySelector(".verdict")?.textContent ?? null;
}

describe("изменение правила", () => {
  test("deny на kiten → вопрос → «Да» → y и дерево перечитано", async () => {
    const back = asking();
    renderWith(back.transport, <Rules />);
    await screen.findByText("kiten", { selector: ".path" });
    const before = back.reads();
    fireEvent.click(screen.getByRole("button", { name: "deny для kiten" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "изменить правило: kiten → deny? [y/N]",
    );
    expect(back.seen.find((one) => one.path === "/line")).toEqual({
      path: "/line",
      body: { words: ["deny:", "kiten"], cwd: "/", human: true },
      accept: "application/json",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Да" }));
    await waitFor(() => expect(back.reads()).toBeGreaterThan(before));
    expect(back.seen.find((one) => one.path === "/line/answer")?.body).toEqual({
      ticket: "0123456789abcdef0123456789abcdef",
      answer: "y",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(verdictOf("kiten")).toBe("deny"));
  });

  test("«Нет» и Esc — ответ n, окно закрыто", async () => {
    for (const close of ["click", "escape"] as const) {
      const back = asking();
      renderWith(back.transport, <Rules />);
      await screen.findByText("kiten", { selector: ".path" });
      fireEvent.click(screen.getByRole("button", { name: "deny для kiten" }));
      const dialog = await screen.findByRole("dialog");
      // Фокус — внутри окна.
      expect(dialog.contains(document.activeElement)).toBe(true);
      if (close === "click") {
        fireEvent.click(within(dialog).getByRole("button", { name: "Нет" }));
      } else {
        fireEvent.keyDown(dialog, { key: "Escape" });
      }
      await waitFor(() =>
        expect(back.seen.find((one) => one.path === "/line/answer")?.body)
          .toEqual({ ticket: "0123456789abcdef0123456789abcdef", answer: "n" })
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(verdictOf("kiten")).toBe("ask");
      cleanup();
    }
  });

  test("«сбросить» — только у узла со своим правилом, это forget:", async () => {
    const back = asking();
    renderWith(back.transport, <Rules />);
    await screen.findByText("kiten", { selector: ".path" });
    expect(screen.queryByRole("button", { name: "сбросить sql-ro" }))
      .toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "сбросить kiten" }));
    await screen.findByRole("dialog");
    expect(back.seen.find((one) => one.path === "/line")?.body.words).toEqual([
      "forget:",
      "kiten",
    ]);
  });
});

describe("хранилище", () => {
  test("раскрытые узлы — в localStorage; недоступное хранилище не роняет экран", async () => {
    const back = fakeBack(rpcAnswer());
    renderWith(back.transport, <Rules />);
    await screen.findByText("kiten", { selector: ".path" });
    fireEvent.click(screen.getByRole("button", { name: "раскрыть kiten" }));
    expect(localStorage.getItem("mpu-web:expanded")).toBe('["kiten"]');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("запрещено");
    };
    try {
      fireEvent.click(screen.getByRole("button", { name: "свернуть kiten" }));
      expect(screen.queryByText("kiten card", { selector: ".path" }))
        .toBeNull();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
