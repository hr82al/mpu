/**
 * Экран «Образ» (`web-image.md`, сценарии 13–22): отчёт — `stdout` итога
 * строками, строка `конфликт` — с определением базы и кнопками по адресу
 * из третьего поля, `stderr` — под кнопками, `refusal.hint` — кнопка
 * «Выполнить». Код выхода вид итога не выбирает.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Image } from "./Image.tsx";
import { reportLines } from "./report.ts";
import {
  fakeBack,
  json,
  reads,
  renderWith,
  scripted,
  sentLines,
} from "./testkit.tsx";

afterEach(cleanup);

const question = (ask: string) => ({
  stdout: "",
  stderr: "",
  ask,
  ticket: "0123456789abcdef0123456789abcdef",
});

const SYNC = ["ask", "image", "sync"];
const DRY = [...SYNC, "dry"];
const HINT_TEXT =
  "mpu image sync: удалилось бы 3 из 3 методов (база) — вызывай mpu ask image sync deletes: allow";
const MASS = {
  stdout: "",
  stderr: `${HINT_TEXT}\n`,
  refusal: {
    reason: "удалилось бы",
    hint: ["ask", "image", "sync", "deletes:", "allow"],
    candidates: [],
    text: HINT_TEXT,
  },
  exit: 2,
};
const CONFLICT = {
  stdout:
    "конфликт\tkiten cardsIn:\tkiten.cardsIn\nсовпало 2, изменено 0, конфликтов 1\n",
  stderr: "",
  exit: 1,
};

async function shown(back: ReturnType<typeof scripted>) {
  renderWith(back.transport, <Image />);
  await screen.findByText("Образ", { selector: "h1" });
}

async function press(name: string, answer?: "Да" | "Нет") {
  fireEvent.click(screen.getByRole("button", { name }));
  if (answer === undefined) return undefined;
  const dialog = await screen.findByRole("dialog");
  const asked = dialog.textContent;
  fireEvent.click(within(dialog).getByRole("button", { name: answer }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  return asked;
}

/** Строки отчёта на экране. */
function report(): string[] {
  const list = screen.queryByRole("list", { name: "отчёт" });
  if (list === null) return [];
  return within(list)
    .queryAllByRole("listitem")
    .map((one) =>
      one.querySelector(".path") === null
        ? (one.textContent ?? "")
        : `конфликт ${one.querySelector(".path")?.textContent}`,
    );
}

function said(): string | null {
  return document.querySelector(".said")?.textContent ?? null;
}

describe("экран «Образ»", () => {
  test("13: до действия — «Отчёта ещё нет», две кнопки, строк не ушло", async () => {
    const back = scripted([]);
    await shown(back);
    expect(screen.getByText("Отчёта ещё нет")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Проверить" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Синхронизировать" }),
    ).toBeTruthy();
    expect(sentLines(back.seen)).toEqual([]);
  });

  test("нет сессии и недоступный back — как на «Правилах»", async () => {
    renderWith(fakeBack(() => json({}, 401)).transport, <Image />);
    expect(await screen.findByText(/Откройте ссылку из/)).toBeTruthy();
    cleanup();
    renderWith(fakeBack(() => undefined).transport, <Image />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "mpu-back недоступен на http://mpu.localhost:7338",
    );
  });

  test("14: «Синхронизировать», «Да» — отчёт строкой итога", async () => {
    const back = scripted([
      question("выполнить mpu image sync? [y/N] "),
      { stdout: "совпало 3, изменено 0, конфликтов 0\n", stderr: "", exit: 0 },
    ]);
    await shown(back);
    const asked = await press("Синхронизировать", "Да");
    expect(asked).toContain("выполнить mpu image sync? [y/N]");
    expect(sentLines(back.seen)).toEqual([SYNC]);
    await waitFor(() =>
      expect(report()).toEqual(["совпало 3, изменено 0, конфликтов 0"]),
    );
  });

  test("15: «Проверить» — строка dry, отчёт двумя строками", async () => {
    const back = scripted([
      question("выполнить mpu image sync dry? [y/N] "),
      {
        stdout:
          "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
        stderr: "",
        exit: 0,
      },
    ]);
    await shown(back);
    const asked = await press("Проверить", "Да");
    expect(asked).toContain("выполнить mpu image sync dry? [y/N]");
    expect(sentLines(back.seen)).toEqual([DRY]);
    await waitFor(() =>
      expect(report()).toEqual([
        "база из файла\tkiten cardsIn:",
        "совпало 2, изменено 1, конфликтов 0",
      ]),
    );
  });

  test("16: конфликт с кодом 1 — отчёт, определение базы, кнопки; под кнопкой пусто", async () => {
    const back = scripted([question("?"), CONFLICT]);
    await shown(back);
    await press("Проверить", "Да");
    await waitFor(() =>
      expect(report()).toEqual([
        "конфликт kiten cardsIn:",
        "совпало 2, изменено 0, конфликтов 1",
      ]),
    );
    const row = screen
      .getByText("kiten cardsIn:", { selector: ".path" })
      .closest("li") as HTMLElement;
    expect(row.querySelector(".definition")?.textContent).toBe(
      "kiten define: cardsIn: purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
    );
    expect(
      within(row).getByRole("button", { name: "взять базу" }),
    ).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "взять файлы" }),
    ).toBeTruthy();
    expect(said()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Выполнить/ })).toBeNull();
  });

  test("17: «взять файлы» / «взять базу» — адрес третьим полем как есть", async () => {
    const back = scripted([
      question("?"),
      CONFLICT,
      question("выполнить mpu image sync files: kiten.cardsIn? [y/N] "),
      {
        stdout:
          "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
        stderr: "",
        exit: 0,
      },
      question("?"),
      {
        ...CONFLICT,
        stdout:
          "конфликт\tkiten mine\tадрес-от-back\nсовпало 2, изменено 0, конфликтов 1\n",
      },
      question("?"),
    ]);
    await shown(back);
    await press("Проверить", "Да");
    const asked = await press("взять файлы", "Да");
    expect(asked).toContain(
      "выполнить mpu image sync files: kiten.cardsIn? [y/N]",
    );
    await waitFor(() => expect(report().length).toBe(2));
    await press("Проверить", "Да");
    await screen.findByText("kiten mine", { selector: ".path" });
    fireEvent.click(screen.getByRole("button", { name: "взять базу" }));
    await screen.findByRole("dialog");
    expect(sentLines(back.seen)).toEqual([
      DRY,
      [...SYNC, "files:", "kiten.cardsIn"],
      DRY,
      [...SYNC, "base:", "адрес-от-back"],
    ]);
  });

  test("16: конфликт метода, которого нет в снимке, — «определения нет»", async () => {
    const back = scripted([
      question("?"),
      {
        ...CONFLICT,
        stdout: "конфликт\tkiten gone\tkiten.gone\n",
      },
    ]);
    await shown(back);
    await press("Проверить", "Да");
    const row = (
      await screen.findByText("kiten gone", { selector: ".path" })
    ).closest("li") as HTMLElement;
    expect(row.querySelector(".definition")?.textContent).toBe(
      "определения нет",
    );
  });

  test("19: итог строки перечитывает снимок", async () => {
    // `policy.tree` на этом экране не читается: инвалидация помечает его,
    // и «Правила» перечитают его при показе.
    const back = scripted([question("?"), CONFLICT]);
    await shown(back);
    const before = reads(back.seen, "tree.snapshot");
    await press("Проверить", "Да");
    await waitFor(() =>
      expect(reads(back.seen, "tree.snapshot")).toBeGreaterThan(before),
    );
  });

  test("20: отказ с hint — строк нет, stderr под кнопкой, «Выполнить» шлёт hint", async () => {
    const back = scripted([
      question("выполнить mpu image sync? [y/N] "),
      MASS,
      question("?"),
    ]);
    await shown(back);
    await press("Синхронизировать", "Да");
    await waitFor(() => expect(said()).toBe(HINT_TEXT));
    expect(report()).toEqual([]);
    const run = screen.getByRole("button", {
      name: "Выполнить: mpu ask image sync deletes: allow",
    });
    fireEvent.click(run);
    await screen.findByRole("dialog");
    expect(sentLines(back.seen).at(-1)).toEqual([
      "ask",
      "image",
      "sync",
      "deletes:",
      "allow",
    ]);
  });

  test("20: строка «Выполнить» — hint как есть, не из текста", async () => {
    const hint = ["ask", "image", "sync", "deletes:", "allow", "dir:", "/d"];
    const back = scripted([{ ...MASS, refusal: { ...MASS.refusal, hint } }]);
    await shown(back);
    fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
    const run = await screen.findByRole("button", {
      name: "Выполнить: mpu ask image sync deletes: allow dir: /d",
    });
    fireEvent.click(run);
    await waitFor(() => expect(sentLines(back.seen).length).toBe(2));
    expect(sentLines(back.seen)[1]).toEqual(hint);
  });

  test("21: отказ без hint — текст под кнопкой, «Выполнить» нет, окна нет", async () => {
    const text =
      "mpu image sync: нет права записи в /tmp/x — каталог образа только под /h/mr/mp/mpu/image";
    const back = scripted([
      {
        stdout: "",
        stderr: `${text}\n`,
        refusal: { reason: "отказ", hint: null, candidates: [], text },
        exit: 2,
      },
    ]);
    await shown(back);
    fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
    await waitFor(() => expect(said()).toBe(text));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Выполнить/ })).toBeNull();
  });

  test("22: «Проверить», «Нет» — отказ под кнопкой, строк нет", async () => {
    const text = "mpu image sync dry: не подтверждено";
    const back = scripted([
      question("выполнить mpu image sync dry? [y/N] "),
      {
        stdout: "",
        stderr: `${text}\n`,
        refusal: {
          reason: "не подтверждено",
          hint: null,
          candidates: [],
          text,
        },
        exit: 1,
      },
    ]);
    await shown(back);
    await press("Проверить", "Нет");
    await waitFor(() => expect(said()).toBe(text));
    expect(report()).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Выполнить/ })).toBeNull();
  });
});

describe("строки отчёта", () => {
  test("конфликт — адрес третьим полем; прочее — текст; пустой stdout — строк нет", () => {
    expect(reportLines("")).toEqual([]);
    expect(
      reportLines("конфликт\tkiten cardsIn:\tkiten.cardsIn\nсовпало 2\n"),
    ).toEqual([
      {
        kind: "conflict",
        text: "конфликт\tkiten cardsIn:\tkiten.cardsIn",
        method: "kiten cardsIn:",
        address: "kiten.cardsIn",
      },
      { kind: "text", text: "совпало 2" },
    ]);
  });
});
