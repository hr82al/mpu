/**
 * Колонки резолва против голдена состава таблицы
 * (`docs/specs/fixtures/api/schema/spreadsheets_access_grants.columns`,
 * снят со стенда через `information_schema.columns`).
 *
 * Почему отдельным тестом, а не проверкой на подставной базе: та
 * отвечает на любой запрос, и имя колонки ей безразлично — сочинённое
 * имя проходит все тесты и падает только живьём. Так и случилось с
 * `id`, которого в таблице нет вовсе.
 *
 * Голден отвечает на вопрос «есть ли такая колонка», но не на вопрос
 * «та ли это база»: сверку голдена с живым `information_schema`
 * делает приёмка при поднятом стенде (спека, «Механики группы»).
 */

import { expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  activeGrants,
  GRANTS_TABLE,
  RESOLVE_COLUMNS,
} from "./ss_access.ts";
import type { SqlSession } from "../sql/session.ts";
import { schemaGoldens } from "./schema_golden.ts";

/** Состав колонок из голдена — общим загрузчиком, без второй копии. */
async function goldenColumns(): Promise<readonly string[]> {
  const goldens = await schemaGoldens();
  const grants = goldens.find((one) =>
    one.table === "spreadsheets_access_grants"
  );
  if (grants === undefined) throw new Error("голдена таблицы выдач нет");
  return grants.columns;
}

/** Текст запроса, каким его отправит резолв. */
async function resolveQuery(): Promise<string> {
  let sent = "";
  const session: SqlSession = {
    query: (text: string) => {
      sent = text;
      return Promise.resolve({
        kind: "rows" as const,
        columns: ["grant_id", "status"],
        rows: [],
      });
    },
    run: () => Promise.reject(new Error("run не ожидается")),
    runMany: () => Promise.reject(new Error("runMany не ожидается")),
    close: () => Promise.resolve(),
  };
  await activeGrants(session, "ss", "kto@test");
  return sent;
}

it("каждая колонка резолва есть в голдене схемы", async () => {
  const golden = await goldenColumns();
  // Голден непуст: пустой прошёл бы проверку молча и перестал что-либо
  // значить.
  expect(golden.length > 0).toBe(true);
  const missing = RESOLVE_COLUMNS.filter((name) => !golden.includes(name));
  expect(
    missing,
    `колонок нет в таблице: ${missing.join(", ")}; есть: ${golden.join(", ")}`,
  ).toStrictEqual([]);
  // И обратная сторона: `id` в голдене нет, а значит сочинить его
  // обратно нельзя незаметно.
  expect(golden.includes("id")).toBe(false);
});

it("запрос резолва пользуется только объявленными колонками", async () => {
  const text = await resolveQuery();
  const golden = await goldenColumns();
  // Каждая объявленная колонка в запросе действительно упомянута:
  // иначе список и запрос разошлись бы, и голден стерёг бы не то.
  for (const name of RESOLVE_COLUMNS) {
    expect(text.includes(name), `${name} объявлена, но в запросе её нет`).toBe(
      true,
    );
  }
  // И ни одного имени сверх объявленных: имя-самозванец обязано быть
  // видно здесь, а не на живой базе.
  const used = [...text.matchAll(/\b([a-z_]+)\b/g)]
    .map((match) => match[1])
    .filter((word) => golden.includes(word));
  expect(
    [...new Set(used)].sort(),
    "в запросе есть колонка таблицы, не объявленная в RESOLVE_COLUMNS",
  ).toStrictEqual([...RESOLVE_COLUMNS].sort());
  expect(text.includes(GRANTS_TABLE)).toBe(true);
});

it("статусы резолва — те три, что входят в индекс", () => {
  // Список один на модуль, и он же уходит параметром запроса. Четвёртый
  // статус здесь означал бы отзыв того, что индекс не занимает, и
  // ожидание того, что уже случилось.
  expect([...ACTIVE_STATUSES]).toStrictEqual([
    "created",
    "permission_added",
    "applied",
  ]);
});
