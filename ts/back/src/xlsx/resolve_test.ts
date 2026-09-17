import { assertEquals } from "@std/assert";
import { isAliasLike, resolveXlsxPath } from "./resolve.ts";

const noAliases = () => undefined;

function sources(
  overrides: Partial<Parameters<typeof resolveXlsxPath>[0]>,
): Parameters<typeof resolveXlsxPath>[0] {
  return {
    flagValue: undefined,
    envValue: undefined,
    configValue: undefined,
    aliasPath: noAliases,
    cwd: "/work",
    home: "/home/u",
    ...overrides,
  };
}

Deno.test("isAliasLike: таблица из спеки", async (t) => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["otchet", true],
    ["a-b_c.d", true],
    ["dir/file", false], // содержит «/»
    ["dir\\file", false], // содержит «\»
    ["~tilde", false], // начинается с «~»
    ["report.xlsx", false], // кончается на «.xlsx»
    ["кириллица", false], // вне [A-Za-z0-9_.-]
    ["with space", false],
    ["", false],
  ];
  for (const [value, expected] of cases) {
    await t.step(`«${value}»`, () => {
      assertEquals(isAliasLike(value), expected);
    });
  }
});

Deno.test("resolveXlsxPath: порядок источников — flag, env, config", () => {
  const all = sources({
    flagValue: "/a.xlsx",
    envValue: "/b.xlsx",
    configValue: "/c.xlsx",
  });
  assertEquals(resolveXlsxPath(all).resolved, {
    path: "/a.xlsx",
    source: "flag",
  });
  assertEquals(
    resolveXlsxPath({ ...all, flagValue: undefined }).resolved,
    { path: "/b.xlsx", source: "env" },
  );
  assertEquals(
    resolveXlsxPath({ ...all, flagValue: undefined, envValue: undefined })
      .resolved,
    { path: "/c.xlsx", source: "config" },
  );
});

Deno.test("resolveXlsxPath: пустая строка — источник пропущен", () => {
  const report = resolveXlsxPath(
    sources({ flagValue: "", envValue: "x.xlsx" }),
  );
  assertEquals(report.resolved, { path: "/work/x.xlsx", source: "env" });
  assertEquals(report.checked[0], {
    source: "flag",
    label: "--file/-f",
    value: null,
    used: false,
  });
  assertEquals(report.checked[1], {
    source: "env",
    label: "MPU_XLSX (env-файл)",
    value: "x.xlsx",
    used: true,
  });
  assertEquals(report.checked[2], {
    source: "config",
    label: "config xlsx.default",
    value: null,
    used: false,
  });
});

Deno.test("resolveXlsxPath: алиас найден — путь алиаса и его имя", () => {
  const report = resolveXlsxPath(sources({
    flagValue: "otchet",
    aliasPath: (name) => name === "otchet" ? "~/docs/o.xlsx" : undefined,
  }));
  assertEquals(report.resolved, {
    path: "/home/u/docs/o.xlsx",
    source: "flag",
    alias: "otchet",
  });
});

Deno.test("resolveXlsxPath: похоже на алиас, но не найден — молча путь", () => {
  const report = resolveXlsxPath(sources({ flagValue: "otchet" }));
  assertEquals(report.resolved, { path: "/work/otchet", source: "flag" });
});

Deno.test("resolveXlsxPath: раскрытие «~» и нормализация путей", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["~/f.xlsx", "/home/u/f.xlsx"],
    ["~", "/home/u"],
    ["rel/../f.xlsx", "/work/f.xlsx"],
    ["./f.xlsx", "/work/f.xlsx"],
    ["/abs//x/./f.xlsx", "/abs/x/f.xlsx"],
    ["/../f.xlsx", "/f.xlsx"],
  ];
  for (const [value, expected] of cases) {
    await t.step(`${value} → ${expected}`, () => {
      const report = resolveXlsxPath(sources({ flagValue: value }));
      assertEquals(report.resolved?.path, expected);
    });
  }
});

Deno.test("resolveXlsxPath: ни один источник не дал пути", () => {
  const report = resolveXlsxPath(sources({}));
  assertEquals(report.resolved, null);
  assertEquals(report.checked.map((c) => c.used), [false, false, false]);
});
