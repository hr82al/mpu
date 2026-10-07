/**
 * Отметка дерева: снятие у git и обе формы шапки
 * (`platform/code-analyzer.md`, «Отметка дерева»).
 *
 * Настоящий git не запускается: источник отметки — порт, и подставить
 * ему ответы дешевле и честнее, чем заводить репозиторий на диске ради
 * четырёх строк вывода.
 */

import { describe, expect, it } from "vitest";
import { gitTreeMark, markLabel, renderMark, type RunGit } from "./mark.ts";

/**
 * Ответы `git` по всей строке аргументов; команды нет в таблице —
 * ненулевой код. Ключ целиком, а не по одному слову: `rev-parse HEAD` и
 * `symbolic-ref --short HEAD` кончаются одинаково.
 */
function fakeGit(answers: Readonly<Record<string, string>>): RunGit {
  return (args) => {
    const answer = answers[args.join(" ")];
    return Promise.resolve(
      answer === undefined
        ? { code: 1, stdout: "" }
        : { code: 0, stdout: answer },
    );
  };
}

describe("отметка снимается у git", () => {
  it("ветка, восемь знаков хэша, чистое дерево", async () => {
    const mark = await gitTreeMark(
      fakeGit({
        "rev-parse --show-toplevel": "/w/ozon\n",
        "rev-parse HEAD": "989c0bf9c1c04b0f9e2e2a0f4b4b1d8f4e0f1a2b\n",
        "symbolic-ref --short HEAD": "feat/checklist\n",
        "status --porcelain": "",
      }),
      "/w/ozon",
      "ozon",
    );
    expect(mark).toStrictEqual({
      repo: "ozon",
      state: {
        kind: "git",
        branch: "feat/checklist",
        commit: "989c0bf9",
        dirty: false,
      },
    });
  });

  it("отделённая голова — слово detached", async () => {
    const mark = await gitTreeMark(
      fakeGit({
        "rev-parse --show-toplevel": "/w/ozon\n",
        "rev-parse HEAD": "abcdef0123456789\n",
        "status --porcelain": "",
      }),
      "/w/ozon",
      "ozon",
    );
    expect(mark.state).toStrictEqual({
      kind: "git",
      branch: "detached",
      commit: "abcdef01",
      dirty: false,
    });
  });

  it("непустой status — дерево с изменениями", async () => {
    const mark = await gitTreeMark(
      fakeGit({
        "rev-parse --show-toplevel": "/w/ozon\n",
        "rev-parse HEAD": "abcdef0123456789\n",
        "symbolic-ref --short HEAD": "main\n",
        "status --porcelain": " M src/days.ts\n",
      }),
      "/w/ozon",
      "ozon",
    );
    expect(mark.state).toStrictEqual({
      kind: "git",
      branch: "main",
      commit: "abcdef01",
      dirty: true,
    });
  });

  it("дерево вне git — ответ, а не отказ", async () => {
    const mark = await gitTreeMark(fakeGit({}), "/w/fixture", "fixture");
    expect(mark).toStrictEqual({
      repo: "fixture",
      state: { kind: "out-of-git" },
    });
  });

  it("git не найден — тоже вне git", async () => {
    const mark = await gitTreeMark(() => Promise.resolve(null), "/w/x", "x");
    expect(mark.state.kind).toBe("out-of-git");
  });

  it("корень принадлежит соседу — вне git, а не его отметка", async () => {
    // Каталог с пустым `.git` внутри чужого клона: `git` отвечает про
    // репозиторий-предок, и взять этот ответ значило бы напечатать
    // чужую ветку под своим именем.
    const mark = await gitTreeMark(
      fakeGit({
        "rev-parse --show-toplevel": "/w\n",
        "rev-parse HEAD": "989c0bf9c1c04b0f9e2e2a0f4b4b1d8f4e0f1a2b\n",
        "symbolic-ref --short HEAD": "main\n",
        "status --porcelain": "",
      }),
      "/w/ozon",
      "ozon",
    );
    expect(mark).toStrictEqual({ repo: "ozon", state: { kind: "out-of-git" } });
  });
});

describe("шапка раздела: обе формы отметки и обе гарантии", () => {
  it("под git — пять полей", () => {
    expect(renderMark({
      repo: "ozon",
      state: {
        kind: "git",
        branch: "feat/checklist/serving/screen-data-endpoint",
        commit: "989c0bf9",
        dirty: false,
      },
    }, "types")).toBe(
      "ozon · feat/checklist/serving/screen-data-endpoint · 989c0bf9 · дерево чистое · разбор по типам — ответ полон",
    );
  });

  it("вне git — три поля, гарантия названа и пониженная", () => {
    expect(
      renderMark({ repo: "fixture", state: { kind: "out-of-git" } }, "text"),
    ).toBe("fixture · вне git · текстовый разбор — ответ неполон");
  });

  it("короткая форма для сообщений об ошибках", () => {
    expect(markLabel({ repo: "x", state: { kind: "out-of-git" } })).toBe(
      "вне git",
    );
    expect(markLabel({
      repo: "x",
      state: { kind: "git", branch: "main", commit: "989c0bf9", dirty: true },
    })).toBe("main 989c0bf9");
  });
});
