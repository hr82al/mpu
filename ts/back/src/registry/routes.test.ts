/**
 * Видимость команд обоих маршрутов: справочные поверхности перечисляют
 * их одинаково (`platform/registry.md`), а состав тулов задаётся
 * закрытым списком публикации, а не маршрутом.
 */

import { describe, expect, it } from "vitest";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { childrenOf, commands, surfaces } from "./mod.ts";
import { type Profile, profileTools } from "../mcp/mod.ts";
import toolPolicies from "../../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};

const PROFILES: readonly Profile[] = ["ro", "rw"];

async function help(...argv: string[]): Promise<string> {
  const out: string[] = [];
  await runCli(argv, makeFakeIo(), {
    stdout: (text) => void out.push(text),
    stderr: () => {},
  });
  return out.join("");
}

// Проверка «одно имя — один маршрут» удалена вместе с предметом:
// списков маршрутов было два, остался один (порция 97). Пересечься
// теперь не с чем, а утверждение о пустом пересечении с самим собой
// было бы зелёным всегда.

it("справка группы telegram собирается из реестра", () => {
  // Пока группа шла подпроцессом (до порции 95),
  // `mpu telegram --help` печатал справку Python-версии: из шести
  // подкоманд она называла три — оператор читал список команд,
  // которого уже нет. Проверяется состав, а не текст: имена берутся из
  // реестра, поэтому новая подкоманда не потребует правки проверки.
  const names = childrenOf(["telegram"]).map((child) => child.name);
  expect([...names].sort()).toStrictEqual(
    commands
      .filter((command) => command.path[0] === "telegram")
      .map((command) => command.path[1])
      .sort(),
  );
  expect(names.length, `в группе не семь листьев: ${names}`).toBe(7);
});

describe("инварианты записей реестра", () => {
  const entries = commands.map((command) => ({
    name: command.path.join(" "),
    summary: command.summary,
  }));

  // Непустота реестра — предпосылка всех случаев ниже, поэтому стоит до
  // первого из них, при сборе: внутри случая она ушла бы вместе с ним,
  // молча сняв защиту с остальных. У пустого реестра каждый случай прошёл
  // бы, не проверив ни одной записи.
  expect(entries.length > 0, "реестр пуст: проверять нечего").toBe(true);

  it("у каждой записи непустая однострока", () => {
    expect(
      entries.filter((entry) => entry.summary.trim() === "").map((e) => e.name),
    ).toStrictEqual([]);
  });

  // Шаг «маршрут объявлен и ровно один» удалён вместе с предметом:
  // маршрут остался один (порция 97), и поле, которое он проверял,
  // проставлялось тут же — утверждение было зелёным по построению.

  it("имена уникальны", () => {
    const names = entries.map((entry) => entry.name);
    expect(new Set(names).size, "в реестре есть дубли").toStrictEqual(
      names.length,
    );
  });

  it("порядок команд — объявленный, а не алфавитный", () => {
    // Прежде здесь стерёгся порядок записей слепка; подпроцессных
    // команд не осталось (порция 97), и стеречь остался порядок
    // реестра. Сравнение двух обращений подряд отсюда убрано: один и
    // тот же замороженный массив, отображённый дважды, совпал бы при
    // любой мутации порядка.
    const names = commands.map((command) => command.path.join(" "));
    expect(names[0], `первым идёт не xlsx ls: ${names[0]}`).toBe("xlsx ls");
    expect(names.slice(0, 3), "порядок объявления команд изменился")
      .toStrictEqual(["xlsx ls", "xlsx get", "xlsx open"]);
  });
});

it("индекс корня перечисляет всё дерево", async () => {
  const index = await help("--help");
  expect(index).toContain("xlsx");
  expect(index).toContain("search");
  // Поверхности точки входа — наравне с командами: способ исполнения
  // на состав справки не влияет.
  expect(index).toContain("help");
  // Поверхностей две (`help`, `version`); пустой список прошёл бы
  // цикл, не проверив ни одной строки.
  expect(surfaces.length > 0, "поверхностей нет вовсе").toBe(true);
  for (const surface of surfaces) {
    expect(index).toContain(surface.summary);
  }
  // Порядок — порядок реестра, а не алфавит.
  expect(index.indexOf("xlsx") < index.indexOf("search")).toBe(true);
});

describe("тулом становится команда из закрытого списка", () => {
  // Публикацию решает закрытый список (`platform/mcp-server.md`), а не
  // способ исполнения; способов с порции 97 остался один.
  const names = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => entry.tool.name)
  );

  it("команда контракта — из объявления в коде", () => {
    expect(names.includes("xlsx_ls")).toBe(true);
  });

  it("публикуется только объявленное командой", () => {
    // Прежние образцы подпроцессных тулов — `search`, `mp-init`,
    // `sheet batch-get`, `api wb-loader-*` — переехали все, а сам
    // маршрут снят (порция 97). Закрытый список публикации теперь
    // целиком состоит из команд контракта, и это проверяемо: каждое
    // опубликованное имя есть среди команд реестра.
    const known = new Set(commands.map((command) => command.path.join(" ")));
    const published = [...toolPolicies.ro, ...toolPolicies.rw];
    expect(published.length > 0).toBe(true);
    expect(published.filter((name) => !known.has(name))).toStrictEqual([]);
  });

  it("запись реестра вне списка публикации тула не даёт", () => {
    // `mpu copy-client` в реестре есть — и с переездом на `native` она
    // объявлена контрактом, — а в закрытом списке публикации её нет:
    // мост прод → локаль агенту не отдают (fail-closed).
    expect(commands.some((command) => command.path.join(" ") === "copy-client"))
      .toBe(true);
    expect(names.includes("copy_client")).toBe(false);
  });
});
