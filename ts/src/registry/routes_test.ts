/**
 * Видимость команд обоих маршрутов: справочные поверхности перечисляют
 * их одинаково (`platform/registry.md`), а состав тулов задаётся
 * закрытым списком публикации, а не маршрутом.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  childrenOf,
  commands,
  findLegacy,
  legacyCommands,
  surfaces,
} from "./mod.ts";
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

Deno.test("пилотная команда маршрута legacy есть в реестре", () => {
  // Пилотом был `search`, за ним `sheet` — оба переехали на маршрут
  // `native`. Роль образца перешла к `iu-wb`: `d2-miro`, стоявший
  // здесь до него, уезжает следующим коммитом, и образец переставлен
  // заранее — чтобы дифф переезда был про переезд.
  const entry = findLegacy(["iu-wb"]);
  assertEquals(entry?.path, ["iu-wb"]);
  // Однострока обязательна: из неё собирается индекс родителя.
  assertEquals((entry?.summary ?? "").length > 0, true);
  // Командой контракта она не является — схем и рендера у неё нет.
  assertEquals(commands.some((c) => c.path.join(" ") === "iu-wb"), false);
});

Deno.test("одно имя — один маршрут", () => {
  // Маршрутизация детерминирована (`platform/registry.md`): имя не
  // может лежать в обоих списках, иначе исход зависел бы от порядка
  // проверок в точке входа.
  const native = new Set(commands.map((command) => command.path.join(" ")));
  assertEquals(
    legacyCommands
      .map((command) => command.path.join(" "))
      .filter((name) => native.has(name)),
    [],
  );
});

Deno.test("справка группы telegram собирается из реестра", () => {
  // До порции 95 группа стояла на маршруте `legacy`, и
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
  // И самой группы больше нет среди подпроцессных имён.
  assertEquals(findLegacy(["telegram"]), undefined);
});

Deno.test("инварианты записей реестра", async (t) => {
  const entries = [
    ...commands.map((command) => ({
      name: command.path.join(" "),
      summary: command.summary,
      route: "native" as const,
    })),
    ...legacyCommands.map((command) => ({
      name: command.path.join(" "),
      summary: command.summary,
      route: "legacy" as const,
    })),
  ];

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

  await t.step("маршрут объявлен и ровно один", () => {
    // Маршрут выражен списком, в котором лежит запись: пересечение
    // списков означало бы имя с двумя маршрутами сразу.
    for (const entry of entries) {
      assertEquals(
        entry.route === "native" || entry.route === "legacy",
        true,
        `${entry.name}: маршрут не объявлен`,
      );
    }
  });

  await t.step("имена уникальны", () => {
    const names = entries.map((entry) => entry.name);
    assertEquals(new Set(names).size, names.length, "в реестре есть дубли");
  });

  await t.step("порядок стабилен между обращениями", () => {
    const once = legacyCommands.map((command) => command.path.join(" "));
    const twice = legacyCommands.map((command) => command.path.join(" "));
    assertEquals(once, twice);
    // Порядок — порядок слепка, не алфавит: первым идёт `iu-wb`
    // (прежние первые — `search`, `sun`, `config`, `sheet`, `d2-miro`,
    // `telegram` — уехали маршрутом `native`).
    assertEquals(once[0], "iu-wb");
  });
});

Deno.test("индекс корня перечисляет всё дерево", async () => {
  const index = await help("--help");
  assertStringIncludes(index, "xlsx");
  assertStringIncludes(index, "search");
  // Поверхности точки входа — наравне с записями маршрутов: способ
  // исполнения на состав справки не влияет.
  assertStringIncludes(index, "help");
  assertStringIncludes(index, "mcp");
  // Поверхностей две (`help`, `version`); пустой список прошёл бы
  // цикл, не проверив ни одной строки.
  assertEquals(surfaces.length > 0, true, "поверхностей нет вовсе");
  for (const surface of surfaces) {
    assertStringIncludes(index, surface.summary);
  }
  // Порядок — порядок реестра: native впереди, legacy следом.
  assertEquals(index.indexOf("xlsx") < index.indexOf("search"), true);
});

Deno.test("тулом становится команда любого маршрута", async (t) => {
  // Маршрут не решает, публикуется ли команда: решает закрытый список
  // (`platform/mcp-server.md`). Здесь — что обе стороны представлены.
  const names = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => entry.tool.name)
  );

  await t.step("команда контракта — из объявления в коде", () => {
    assertEquals(names.includes("xlsx_ls"), true);
  });

  await t.step("публикуемых команд маршрута legacy не осталось", () => {
    // Прежние образцы — `search`, `mp-init`, `sheet batch-get`,
    // `api wb-loader-*` — переехали все. Закрытый список публикации
    // теперь целиком состоит из команд контракта, и это проверяемо:
    // каждое опубликованное имя есть среди команд реестра.
    const known = new Set(commands.map((command) => command.path.join(" ")));
    const published = [...toolPolicies.ro, ...toolPolicies.rw];
    assertEquals(published.length > 0, true);
    assertEquals(published.filter((name) => !known.has(name)), []);
    // Подпроцессные имена в реестре при этом остались: их два, и
    // публикации у них нет.
    assertEquals(findLegacy(["iu-wb"])?.path, ["iu-wb"]);
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
