import { assertEquals } from "@std/assert";
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

Deno.test("умолчания, когда ключей нет", () => {
  assertEquals(settingsOf({}), {
    enabled: true,
    file: DEFAULT_FILE,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxBytes: DEFAULT_MAX_BYTES,
    keep: DEFAULT_KEEP,
    notes: [],
  });
});

Deno.test("числа умолчаний — из спеки", () => {
  assertEquals(DEFAULT_MAX_OUTPUT_BYTES, 8 * 1024 * 1024);
  assertEquals(DEFAULT_MAX_BYTES, 50_000_000);
  assertEquals(DEFAULT_KEEP, 5);
});

Deno.test("выключение журнала", async (t) => {
  for (const value of ["0", "off", "false", "no", "OFF", "False", "No"]) {
    await t.step(`MPU_LOG_ENABLED=${value} — выключен`, () => {
      assertEquals(settingsOf({ MPU_LOG_ENABLED: value }).enabled, false);
    });
  }
  for (const value of ["1", "on", "true", "yes", ""]) {
    await t.step(`MPU_LOG_ENABLED=${value} — включён`, () => {
      assertEquals(settingsOf({ MPU_LOG_ENABLED: value }).enabled, true);
    });
  }
});

Deno.test("путь файла — из ключа, иначе дефолт", async (t) => {
  await t.step("ключ задан", () => {
    assertEquals(settingsOf({ MPU_LOG_FILE: "/tmp/a.log" }).file, "/tmp/a.log");
  });
  await t.step("пустой ключ равнозначен незаданному", () => {
    assertEquals(settingsOf({ MPU_LOG_FILE: "" }).file, DEFAULT_FILE);
  });
  await t.step("дефолта нет — журналу некуда писать", () => {
    assertEquals(
      readSettings({ get: () => undefined }, undefined).file,
      undefined,
    );
  });
});

Deno.test("числовые ключи", async (t) => {
  await t.step("значения читаются", () => {
    const settings = settingsOf({
      MPU_LOG_MAX_OUTPUT_BYTES: "1024",
      MPU_LOG_MAX_BYTES: "2048",
      MPU_LOG_KEEP: "0",
    });
    assertEquals(settings.maxOutputBytes, 1024);
    assertEquals(settings.maxBytes, 2048);
    assertEquals(settings.keep, 0);
    assertEquals(settings.notes, []);
  });
  await t.step("ноль — осмысленное значение, не «не задано»", () => {
    assertEquals(
      settingsOf({ MPU_LOG_MAX_OUTPUT_BYTES: "0" }).maxOutputBytes,
      0,
    );
    assertEquals(settingsOf({ MPU_LOG_MAX_BYTES: "0" }).maxBytes, 0);
  });
});

Deno.test("битое числовое значение — дефолт и note в запись", async (t) => {
  for (const value of ["abc", "-1", "1.5", "8 МиБ", " "]) {
    await t.step(`MPU_LOG_KEEP=${JSON.stringify(value)}`, () => {
      const settings = settingsOf({ MPU_LOG_KEEP: value });
      assertEquals(settings.keep, DEFAULT_KEEP);
      assertEquals(settings.notes, [
        `MPU_LOG_KEEP=${value}: не целое неотрицательное число,` +
        ` взято умолчание ${DEFAULT_KEEP}`,
      ]);
    });
  }
  await t.step("битых несколько — note на каждое", () => {
    const settings = settingsOf({
      MPU_LOG_MAX_BYTES: "x",
      MPU_LOG_KEEP: "y",
    });
    assertEquals(settings.notes.length, 2);
    assertEquals(settings.maxBytes, DEFAULT_MAX_BYTES);
    assertEquals(settings.keep, DEFAULT_KEEP);
  });
});
