/**
 * `mpu jsdate` (`docs/specs/jsdate.md`): метка момента и поверхность
 * команды. Момент и смещение пояса приходят числами — ни стенные часы,
 * ни пояс машины в проверке не участвуют.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { jsdateCommand, jsDateStamp } from "./mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { UsageError } from "../command/mod.ts";

/** Смещение в форме `Date.getTimezoneOffset()`: минуты местное → UTC. */
const UTC = 0;
const MSK = -180;
const KATHMANDU = -345;

Deno.test("метка — 14 цифр местного времени", async (t) => {
  const cases: readonly {
    name: string;
    iso: string;
    offset: number;
    stamp: string;
  }[] = [
    {
      name: "UTC",
      iso: "2026-08-18T12:34:56.789Z",
      offset: UTC,
      stamp: "20260818123456",
    },
    {
      name: "+03:00",
      iso: "2026-08-18T12:34:56.789Z",
      offset: MSK,
      stamp: "20260818153456",
    },
    // Переход через полночь вместе со сменой года.
    {
      name: "смена года",
      iso: "2026-01-01T22:30:00.000Z",
      offset: MSK,
      stamp: "20260102013000",
    },
    // Однозначные разряды: ведущие нули на месте, длина та же.
    {
      name: "ведущие нули",
      iso: "2026-01-02T03:04:05.000Z",
      offset: UTC,
      stamp: "20260102030405",
    },
    // Смещение, не кратное часу, учитывается в минутах.
    {
      name: "+05:45",
      iso: "2026-08-18T12:00:00.000Z",
      offset: KATHMANDU,
      stamp: "20260818174500",
    },
  ];
  for (const { name, iso, offset, stamp } of cases) {
    await t.step(name, () => {
      assertEquals(jsDateStamp(Date.parse(iso), offset), stamp);
    });
  }
});

Deno.test("stdout — метка и один перевод строки", async () => {
  const result = await jsdateCommand.invoke([], makeFakeIo());
  const text = jsdateCommand.renderResult(result, []);
  assertEquals(/^\d{14}\n$/.test(text), true, `неожиданный вывод: ${text}`);
  assertEquals(jsdateCommand.textExitCode(result), 0);
});

Deno.test("лишний аргумент — ошибка ввода", async () => {
  await assertRejects(
    () => jsdateCommand.invoke(["foo"], makeFakeIo()),
    UsageError,
  );
  await assertRejects(
    () => jsdateCommand.invoke(["--bar"], makeFakeIo()),
    UsageError,
  );
});
