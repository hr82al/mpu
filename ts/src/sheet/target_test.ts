/**
 * Резолв цели (`platform/webapp-http.md`): приоритет источников,
 * разбор значения и тексты отказов. Сети здесь нет по построению.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { resolveTarget, type TargetSources } from "./target.ts";

const ID = "1SyntheticSpreadsheetIdForGoldens0000000000";

/** Источники-заглушки: пустые, если тест не сказал иного. */
function sources(overrides: Partial<TargetSources> = {}): TargetSources {
  return {
    aliasOf: () => undefined,
    byClientId: () => [],
    byTitle: () => [],
    ...overrides,
  };
}

Deno.test("источники не смешиваются: побеждает первый непустой", async (t) => {
  await t.step("флаг старше env и конфига", () => {
    const target = resolveTarget(
      { flag: ID, env: "4326", config: "алиас" },
      sources(),
    );
    assertEquals(target.source, "flag");
    assertEquals(target.kind, "id");
    assertEquals(target.ss_id, ID);
  });

  await t.step("env старше конфига", () => {
    const target = resolveTarget({ env: ID, config: "алиас" }, sources());
    assertEquals(target.source, "env");
  });

  await t.step("конфиг — последний", () => {
    assertEquals(resolveTarget({ config: ID }, sources()).source, "config");
  });

  await t.step("пустая строка источником не считается", () => {
    assertEquals(
      resolveTarget({ flag: "  ", env: ID }, sources()).source,
      "env",
    );
  });
});

Deno.test("разбор значения по видам", async (t) => {
  await t.step("ссылка", () => {
    const target = resolveTarget({
      flag: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
    }, sources());
    assertEquals(target.kind, "url");
    assertEquals(target.ss_id, ID);
  });

  await t.step("алиас старше client_id и заголовка", () => {
    const target = resolveTarget(
      { flag: "отчёт" },
      sources({ aliasOf: (name) => name === "отчёт" ? ID : undefined }),
    );
    assertEquals(target.kind, "alias");
    assertEquals(target.ss_id, ID);
  });

  await t.step("client_id — только цифры", () => {
    const target = resolveTarget(
      { flag: "4326" },
      sources({ byClientId: () => [{ ssId: ID, title: "Отчёт" }] }),
    );
    assertEquals(target.kind, "client_id");
  });

  await t.step("иначе — подстрока заголовка", () => {
    const target = resolveTarget(
      { flag: "отч" },
      sources({ byTitle: () => [{ ssId: ID, title: "Отчёт WB" }] }),
    );
    assertEquals(target.kind, "title_fuzzy");
    assertEquals(target.original_input, "отч");
  });
});

Deno.test("отказы резолва — тексты атома дословно", async (t) => {
  await t.step("цель не задана", () => {
    const err = assertThrows(
      () => resolveTarget({}, sources()),
      UsageError,
    );
    assertEquals(
      err.message,
      "Spreadsheet не указан. Используй --spreadsheet/-s, export " +
        "MPU_SS=<id-or-name>, или установи `sheet.default` в config.",
    );
  });

  await t.step("client_id без совпадений", () => {
    const err = assertThrows(
      () => resolveTarget({ flag: "4326" }, sources()),
      UsageError,
    );
    assertEquals(
      err.message,
      "client_id=4326 не найден в sl_spreadsheets. Запусти `mpu sheet " +
        "sync` чтобы обновить кэш.",
    );
  });

  await t.step("заголовок без совпадений", () => {
    const err = assertThrows(
      () => resolveTarget({ flag: "нет такого" }, sources()),
      UsageError,
    );
    assertEquals(
      err.message,
      "Spreadsheet 'нет такого' не найден ни как ID/URL/alias/client_id/" +
        "title. Запусти `mpu sheet sync` чтобы обновить кэш.",
    );
  });

  await t.step("несколько совпадений — многострочный список", () => {
    const err = assertThrows(
      () =>
        resolveTarget(
          { flag: "отч" },
          sources({
            byTitle: () => [
              { ssId: "id-1", title: "Отчёт WB" },
              { ssId: "id-2", title: "Отчёт Ozon" },
            ],
          }),
        ),
      UsageError,
    );
    assertEquals(err.message.split("\n"), [
      "Несколько spreadsheet'ов матчат 'отч':",
      "  id-1  Отчёт WB",
      "  id-2  Отчёт Ozon",
      "Уточни через --spreadsheet/-s или используй точный ID/alias.",
    ]);
  });

  await t.step("больше десяти кандидатов сворачиваются", () => {
    const many = Array.from({ length: 13 }, (_, index) => ({
      ssId: `id-${index}`,
      title: `Отчёт ${index}`,
    }));
    const err = assertThrows(
      () => resolveTarget({ flag: "отч" }, sources({ byTitle: () => many })),
      UsageError,
    );
    const lines = err.message.split("\n");
    assertEquals(lines.length, 13);
    assertEquals(lines[11], "  …(+3 more)");
  });
});
