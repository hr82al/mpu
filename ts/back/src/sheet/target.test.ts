/**
 * Резолв цели (`platform/webapp-http.md`): приоритет источников,
 * разбор значения и тексты отказов. Сети здесь нет по построению.
 */

import { describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
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

describe("источники не смешиваются: побеждает первый непустой", () => {
  it("флаг старше конфига", () => {
    const target = resolveTarget({ flag: ID, config: "алиас" }, sources());
    expect(target.source).toBe("flag");
    expect(target.kind).toBe("id");
    expect(target.ss_id).toStrictEqual(ID);
  });

  it("конфиг — второй и последний", () => {
    expect(resolveTarget({ config: ID }, sources()).source).toBe("config");
  });

  it("пустая строка источником не считается", () => {
    expect(resolveTarget({ flag: "  ", config: ID }, sources()).source).toBe(
      "config",
    );
  });

  it("переменных окружения среди источников нет", () => {
    // Решение пользователя: «только явно через параметры». Источника
    // `env` у резолва нет, и значение `"env"` в выводе не появляется
    // никогда (`sheet.md`, отклонение `fix`).
    const err = thrown(() => {
      resolveTarget({}, sources());
    }, UsageError);
    expect(err.message.includes("MPU_SS")).toBe(false);
    expect(err.message.includes("export")).toBe(false);
  });
});

describe("разбор значения по видам", () => {
  it("ссылка", () => {
    const target = resolveTarget(
      {
        flag: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      },
      sources(),
    );
    expect(target.kind).toBe("url");
    expect(target.ss_id).toStrictEqual(ID);
  });

  it("алиас старше client_id и заголовка", () => {
    const target = resolveTarget(
      { flag: "отчёт" },
      sources({ aliasOf: (name) => (name === "отчёт" ? ID : undefined) }),
    );
    expect(target.kind).toBe("alias");
    expect(target.ss_id).toStrictEqual(ID);
  });

  it("client_id — только цифры", () => {
    const target = resolveTarget(
      { flag: "4326" },
      sources({ byClientId: () => [{ ssId: ID, title: "Отчёт" }] }),
    );
    expect(target.kind).toBe("client_id");
  });

  it("иначе — подстрока заголовка", () => {
    const target = resolveTarget(
      { flag: "отч" },
      sources({ byTitle: () => [{ ssId: ID, title: "Отчёт WB" }] }),
    );
    expect(target.kind).toBe("title_fuzzy");
    expect(target.original_input).toBe("отч");
  });
});

describe("отказы резолва — тексты атома дословно", () => {
  it("цель не задана", () => {
    const err = thrown(() => {
      resolveTarget({}, sources());
    }, UsageError);
    expect(err.message).toStrictEqual(
      "Spreadsheet не указан. Используй --spreadsheet/-s или установи " +
        "`sheet.default`: mpu config key: sheet.default value: <id-or-name>.",
    );
  });

  it("client_id без совпадений", () => {
    const err = thrown(() => {
      resolveTarget({ flag: "4326" }, sources());
    }, UsageError);
    expect(err.message).toStrictEqual(
      "client_id=4326 не найден в sl_spreadsheets. Запусти `mpu sheet " +
        "sync` чтобы обновить кэш.",
    );
  });

  it("заголовок без совпадений", () => {
    const err = thrown(() => {
      resolveTarget({ flag: "нет такого" }, sources());
    }, UsageError);
    expect(err.message).toStrictEqual(
      "Spreadsheet 'нет такого' не найден ни как ID/URL/alias/client_id/" +
        "title. Запусти `mpu sheet sync` чтобы обновить кэш.",
    );
  });

  it("несколько совпадений — многострочный список", () => {
    const err = thrown(() => {
      resolveTarget(
        { flag: "отч" },
        sources({
          byTitle: () => [
            { ssId: "id-1", title: "Отчёт WB" },
            { ssId: "id-2", title: "Отчёт Ozon" },
          ],
        }),
      );
    }, UsageError);
    expect(err.message.split("\n")).toStrictEqual([
      "Несколько spreadsheet'ов матчат 'отч':",
      "  id-1  Отчёт WB",
      "  id-2  Отчёт Ozon",
      "Уточни через --spreadsheet/-s или используй точный ID/alias.",
    ]);
  });

  it("больше десяти кандидатов сворачиваются", () => {
    const many = Array.from({ length: 13 }, (_, index) => ({
      ssId: `id-${index}`,
      title: `Отчёт ${index}`,
    }));
    const err = thrown(() => {
      resolveTarget({ flag: "отч" }, sources({ byTitle: () => many }));
    }, UsageError);
    const lines = err.message.split("\n");
    expect(lines.length).toBe(13);
    expect(lines[11]).toBe("  …(+3 more)");
  });
});
