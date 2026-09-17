/**
 * Отметка дерева: снятие у git и обе формы шапки
 * (`platform/code-analyzer.md`, «Отметка дерева»).
 *
 * Настоящий git не запускается: источник отметки — порт, и подставить
 * ему ответы дешевле и честнее, чем заводить репозиторий на диске ради
 * четырёх строк вывода.
 */

import { assertEquals } from "@std/assert";
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

Deno.test("отметка снимается у git", async (t) => {
  await t.step("ветка, восемь знаков хэша, чистое дерево", async () => {
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
    assertEquals(mark, {
      repo: "ozon",
      state: {
        kind: "git",
        branch: "feat/checklist",
        commit: "989c0bf9",
        dirty: false,
      },
    });
  });

  await t.step("отделённая голова — слово detached", async () => {
    const mark = await gitTreeMark(
      fakeGit({
        "rev-parse --show-toplevel": "/w/ozon\n",
        "rev-parse HEAD": "abcdef0123456789\n",
        "status --porcelain": "",
      }),
      "/w/ozon",
      "ozon",
    );
    assertEquals(
      mark.state,
      { kind: "git", branch: "detached", commit: "abcdef01", dirty: false },
    );
  });

  await t.step("непустой status — дерево с изменениями", async () => {
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
    assertEquals(
      mark.state,
      { kind: "git", branch: "main", commit: "abcdef01", dirty: true },
    );
  });

  await t.step("дерево вне git — ответ, а не отказ", async () => {
    const mark = await gitTreeMark(fakeGit({}), "/w/fixture", "fixture");
    assertEquals(mark, { repo: "fixture", state: { kind: "out-of-git" } });
  });

  await t.step("git не найден — тоже вне git", async () => {
    const mark = await gitTreeMark(() => Promise.resolve(null), "/w/x", "x");
    assertEquals(mark.state.kind, "out-of-git");
  });

  await t.step(
    "корень принадлежит соседу — вне git, а не его отметка",
    async () => {
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
      assertEquals(mark, { repo: "ozon", state: { kind: "out-of-git" } });
    },
  );
});

Deno.test("шапка раздела: обе формы отметки и обе гарантии", async (t) => {
  await t.step("под git — пять полей", () => {
    assertEquals(
      renderMark({
        repo: "ozon",
        state: {
          kind: "git",
          branch: "feat/checklist/serving/screen-data-endpoint",
          commit: "989c0bf9",
          dirty: false,
        },
      }, "types"),
      "ozon · feat/checklist/serving/screen-data-endpoint · 989c0bf9 · дерево чистое · разбор по типам — ответ полон",
    );
  });

  await t.step("вне git — три поля, гарантия названа и пониженная", () => {
    assertEquals(
      renderMark({ repo: "fixture", state: { kind: "out-of-git" } }, "text"),
      "fixture · вне git · текстовый разбор — ответ неполон",
    );
  });

  await t.step("короткая форма для сообщений об ошибках", () => {
    assertEquals(
      markLabel({ repo: "x", state: { kind: "out-of-git" } }),
      "вне git",
    );
    assertEquals(
      markLabel({
        repo: "x",
        state: { kind: "git", branch: "main", commit: "989c0bf9", dirty: true },
      }),
      "main 989c0bf9",
    );
  });
});
