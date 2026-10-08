import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  readSettings,
} from "./settings.ts";

const DEFAULT_FILE = "/home/user/.config/mpu/mpu.log";

function settingsOf(values: Readonly<Record<string, string>>) {
  return readSettings({ get: (name) => values[name] }, DEFAULT_FILE);
}

it("умолчания, когда ключей нет", () => {
  expect(settingsOf({})).toStrictEqual({
    enabled: true,
    file: DEFAULT_FILE,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxBytes: DEFAULT_MAX_BYTES,
    keep: DEFAULT_KEEP,
    notes: [],
  });
});

it("числа умолчаний — из спеки", () => {
  expect(DEFAULT_MAX_OUTPUT_BYTES).toStrictEqual(8 * 1024 * 1024);
  expect(DEFAULT_MAX_BYTES).toBe(50_000_000);
  expect(DEFAULT_KEEP).toBe(5);
});

describe("выключение журнала", () => {
  for (const value of ["0", "off", "false", "no", "OFF", "False", "No"]) {
    it(`MPU_LOG_ENABLED=${value} — выключен`, () => {
      expect(settingsOf({ MPU_LOG_ENABLED: value }).enabled).toBe(false);
    });
  }
  for (const value of ["1", "on", "true", "yes", ""]) {
    it(`MPU_LOG_ENABLED=${value} — включён`, () => {
      expect(settingsOf({ MPU_LOG_ENABLED: value }).enabled).toBe(true);
    });
  }
});

describe("путь файла — из ключа, иначе дефолт", () => {
  it("ключ задан", () => {
    expect(settingsOf({ MPU_LOG_FILE: "/tmp/a.log" }).file).toBe("/tmp/a.log");
  });
  it("пустой ключ равнозначен незаданному", () => {
    expect(settingsOf({ MPU_LOG_FILE: "" }).file).toStrictEqual(DEFAULT_FILE);
  });
  it("дефолта нет — журналу некуда писать", () => {
    expect(
      readSettings({ get: () => undefined }, undefined).file,
    ).toStrictEqual(undefined);
  });
});

describe("числовые ключи", () => {
  it("значения читаются", () => {
    const settings = settingsOf({
      MPU_LOG_MAX_OUTPUT_BYTES: "1024",
      MPU_LOG_MAX_BYTES: "2048",
      MPU_LOG_KEEP: "0",
    });
    expect(settings.maxOutputBytes).toBe(1024);
    expect(settings.maxBytes).toBe(2048);
    expect(settings.keep).toBe(0);
    expect(settings.notes).toStrictEqual([]);
  });
  it("ноль — осмысленное значение, не «не задано»", () => {
    expect(settingsOf({ MPU_LOG_MAX_OUTPUT_BYTES: "0" }).maxOutputBytes).toBe(
      0,
    );
    expect(settingsOf({ MPU_LOG_MAX_BYTES: "0" }).maxBytes).toBe(0);
  });
});

describe("битое числовое значение — дефолт и note в запись", () => {
  for (const value of ["abc", "-1", "1.5", "8 МиБ", " "]) {
    it(`MPU_LOG_KEEP=${JSON.stringify(value)}`, () => {
      const settings = settingsOf({ MPU_LOG_KEEP: value });
      expect(settings.keep).toStrictEqual(DEFAULT_KEEP);
      expect(settings.notes).toStrictEqual([
        `MPU_LOG_KEEP=${value}: не целое неотрицательное число,` +
          ` взято умолчание ${DEFAULT_KEEP}`,
      ]);
    });
  }
  it("битых несколько — note на каждое", () => {
    const settings = settingsOf({
      MPU_LOG_MAX_BYTES: "x",
      MPU_LOG_KEEP: "y",
    });
    expect(settings.notes.length).toBe(2);
    expect(settings.maxBytes).toStrictEqual(DEFAULT_MAX_BYTES);
    expect(settings.keep).toStrictEqual(DEFAULT_KEEP);
  });
});
