/**
 * Видимость команд обоих маршрутов: справочные поверхности перечисляют
 * их одинаково (`platform/registry.md`), а состав тулов задаётся
 * закрытым списком публикации, а не маршрутом.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { childrenOf, commands, surfaces } from "./mod.ts";
import { type Profile, profileTools } from "../mcp/mod.ts";
import toolPolicies from "../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
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

Deno.test("справка группы telegram собирается из реестра", () => {
  // Пока группа шла подпроцессом (до порции 95),
  // `mpu telegram --help` печатал справку Python-версии: из шести
  // подкоманд она называла три — оператор читал список команд,
  // которого уже нет. Проверяется состав, а не текст: имена берутся из
  // реестра, поэтому новая подкоманда не потребует правки проверки.
  const names = childrenOf(["telegram"]).map((child) => child.name);
  assertEquals(
    [...names].sort(),
    commands
      .filter((command) => command.path[0] === "telegram")
      .map((command) => command.path[1])
      .sort(),
  );
  assertEquals(names.length, 6, `в группе не шесть листьев: ${names}`);
});

Deno.test("инварианты записей реестра", async (t) => {
  const entries = commands.map((command) => ({
    name: command.path.join(" "),
    summary: command.summary,
  }));

  // Непустота реестра — предпосылка всех шагов ниже, поэтому стоит до
  // первого из них: внутри шага она ушла бы вместе с ним, молча сняв
  // защиту с остальных. У пустого реестра каждый шаг прошёл бы, не
  // проверив ни одной записи.
  assertEquals(entries.length > 0, true, "реестр пуст: проверять нечего");

  await t.step("у каждой записи непустая однострока", () => {
    assertEquals(
      entries.filter((entry) => entry.summary.trim() === "").map((e) => e.name),
      [],
    );
  });

  // Шаг «маршрут объявлен и ровно один» удалён вместе с предметом:
  // маршрут остался один (порция 97), и поле, которое он проверял,
  // проставлялось тут же — утверждение было зелёным по построению.

  await t.step("имена уникальны", () => {
    const names = entries.map((entry) => entry.name);
    assertEquals(new Set(names).size, names.length, "в реестре есть дубли");
  });

  await t.step("порядок команд — объявленный, а не алфавитный", () => {
    // Прежде здесь стерёгся порядок записей слепка; подпроцессных
    // команд не осталось (порция 97), и стеречь остался порядок
    // реестра. Сравнение двух обращений подряд отсюда убрано: один и
    // тот же замороженный массив, отображённый дважды, совпал бы при
    // любой мутации порядка.
    const names = commands.map((command) => command.path.join(" "));
    assertEquals(names[0], "xlsx ls", `первым идёт не xlsx ls: ${names[0]}`);
    assertEquals(
      names.slice(0, 3),
      ["xlsx ls", "xlsx get", "xlsx open"],
      "порядок объявления команд изменился",
    );
  });
});

Deno.test("индекс корня перечисляет всё дерево", async () => {
  const index = await help("--help");
  assertStringIncludes(index, "xlsx");
  assertStringIncludes(index, "search");
  // Поверхности точки входа — наравне с командами: способ исполнения
  // на состав справки не влияет.
  assertStringIncludes(index, "help");
  assertStringIncludes(index, "mcp");
  // Поверхностей две (`help`, `version`); пустой список прошёл бы
  // цикл, не проверив ни одной строки.
  assertEquals(surfaces.length > 0, true, "поверхностей нет вовсе");
  for (const surface of surfaces) {
    assertStringIncludes(index, surface.summary);
  }
  // Порядок — порядок реестра, а не алфавит.
  assertEquals(index.indexOf("xlsx") < index.indexOf("search"), true);
});

Deno.test("тулом становится команда из закрытого списка", async (t) => {
  // Публикацию решает закрытый список (`platform/mcp-server.md`), а не
  // способ исполнения; способов с порции 97 остался один.
  const names = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => entry.tool.name)
  );

  await t.step("команда контракта — из объявления в коде", () => {
    assertEquals(names.includes("xlsx_ls"), true);
  });

  await t.step("публикуется только объявленное командой", () => {
    // Прежние образцы подпроцессных тулов — `search`, `mp-init`,
    // `sheet batch-get`, `api wb-loader-*` — переехали все, а сам
    // маршрут снят (порция 97). Закрытый список публикации теперь
    // целиком состоит из команд контракта, и это проверяемо: каждое
    // опубликованное имя есть среди команд реестра.
    const known = new Set(commands.map((command) => command.path.join(" ")));
    const published = [...toolPolicies.ro, ...toolPolicies.rw];
    assertEquals(published.length > 0, true);
    assertEquals(published.filter((name) => !known.has(name)), []);
  });

  await t.step("запись реестра вне списка публикации тула не даёт", () => {
    // `mpu copy-client` в реестре есть — и с переездом на `native` она
    // объявлена контрактом, — а в закрытом списке публикации её нет:
    // мост прод → локаль агенту не отдают (fail-closed).
    assertEquals(
      commands.some((command) => command.path.join(" ") === "copy-client"),
      true,
    );
    assertEquals(names.includes("copy_client"), false);
  });
});
