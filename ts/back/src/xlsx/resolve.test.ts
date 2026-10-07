import { describe, expect, it } from "vitest";
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

describe("isAliasLike: таблица из спеки", () => {
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
    it(`«${value}»`, () => {
      expect(isAliasLike(value)).toStrictEqual(expected);
    });
  }
});

it("resolveXlsxPath: порядок источников — flag, env, config", () => {
  const all = sources({
    flagValue: "/a.xlsx",
    envValue: "/b.xlsx",
    configValue: "/c.xlsx",
  });
  expect(resolveXlsxPath(all).resolved).toStrictEqual({
    path: "/a.xlsx",
    source: "flag",
  });
  expect(resolveXlsxPath({ ...all, flagValue: undefined }).resolved)
    .toStrictEqual({ path: "/b.xlsx", source: "env" });
  expect(
    resolveXlsxPath({ ...all, flagValue: undefined, envValue: undefined })
      .resolved,
  ).toStrictEqual({ path: "/c.xlsx", source: "config" });
});

it("resolveXlsxPath: пустая строка — источник пропущен", () => {
  const report = resolveXlsxPath(
    sources({ flagValue: "", envValue: "x.xlsx" }),
  );
  expect(report.resolved).toStrictEqual({
    path: "/work/x.xlsx",
    source: "env",
  });
  expect(report.checked[0]).toStrictEqual({
    source: "flag",
    label: "--file/-f",
    value: null,
    used: false,
  });
  expect(report.checked[1]).toStrictEqual({
    source: "env",
    label: "MPU_XLSX (env-файл)",
    value: "x.xlsx",
    used: true,
  });
  expect(report.checked[2]).toStrictEqual({
    source: "config",
    label: "config xlsx.default",
    value: null,
    used: false,
  });
});

it("resolveXlsxPath: алиас найден — путь алиаса и его имя", () => {
  const report = resolveXlsxPath(sources({
    flagValue: "otchet",
    aliasPath: (name) => name === "otchet" ? "~/docs/o.xlsx" : undefined,
  }));
  expect(report.resolved).toStrictEqual({
    path: "/home/u/docs/o.xlsx",
    source: "flag",
    alias: "otchet",
  });
});

it("resolveXlsxPath: похоже на алиас, но не найден — молча путь", () => {
  const report = resolveXlsxPath(sources({ flagValue: "otchet" }));
  expect(report.resolved).toStrictEqual({
    path: "/work/otchet",
    source: "flag",
  });
});

describe("resolveXlsxPath: раскрытие «~» и нормализация путей", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["~/f.xlsx", "/home/u/f.xlsx"],
    ["~", "/home/u"],
    ["rel/../f.xlsx", "/work/f.xlsx"],
    ["./f.xlsx", "/work/f.xlsx"],
    ["/abs//x/./f.xlsx", "/abs/x/f.xlsx"],
    ["/../f.xlsx", "/f.xlsx"],
  ];
  for (const [value, expected] of cases) {
    it(`${value} → ${expected}`, () => {
      const report = resolveXlsxPath(sources({ flagValue: value }));
      expect(report.resolved?.path).toStrictEqual(expected);
    });
  }
});

it("resolveXlsxPath: ни один источник не дал пути", () => {
  const report = resolveXlsxPath(sources({}));
  expect(report.resolved).toStrictEqual(null);
  expect(report.checked.map((c) => c.used)).toStrictEqual([
    false,
    false,
    false,
  ]);
});
