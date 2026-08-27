/**
 * Разбор payload'а хука и сборка текста уведомления
 * (`docs/specs/claude-hook-notification.md`). Сети здесь нет вовсе:
 * обе функции чисты, и проверяются они без петлевого сервера.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { notificationText, parseHookPayload, TEXT_LIMIT } from "./payload.ts";

Deno.test("текст уведомления: проект, тип и сообщение", async (t) => {
  const cases: readonly (readonly [string, string, string])[] = [
    [
      "полный payload",
      JSON.stringify({
        session_id: "s-1",
        cwd: "/home/user/mr/mp/mpu",
        permission_mode: "default",
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        notification_message: "Claude needs your permission to use Bash",
      }),
      "Claude · mpu · permission_prompt\n" +
      "Claude needs your permission to use Bash",
    ],
    [
      "без cwd — часть опускается вместе с разделителем",
      JSON.stringify({
        notification_type: "idle_prompt",
        notification_message: "жду ввода",
      }),
      "Claude · idle_prompt\nжду ввода",
    ],
    [
      "пустой cwd — то же самое",
      JSON.stringify({ cwd: "", notification_type: "idle_prompt" }),
      "Claude · idle_prompt",
    ],
    [
      "текст события — поле message живой пробы",
      JSON.stringify({
        cwd: "/home/user/mr/mp/ozon",
        notification_type: "idle_prompt",
        message: "Claude is waiting for your input",
      }),
      "Claude · ozon · idle_prompt\nClaude is waiting for your input",
    ],
    [
      "message старше notification_message: он подтверждён живым хуком",
      JSON.stringify({
        notification_type: "idle_prompt",
        message: "живое поле",
        notification_message: "поле из доки",
      }),
      "Claude · idle_prompt\nживое поле",
    ],
    [
      "пустой message не заслоняет notification_message",
      JSON.stringify({
        notification_type: "idle_prompt",
        message: "",
        notification_message: "поле из доки",
      }),
      "Claude · idle_prompt\nполе из доки",
    ],
    [
      "нестроковый message не заслоняет notification_message",
      JSON.stringify({
        notification_type: "idle_prompt",
        message: 42,
        notification_message: "поле из доки",
      }),
      "Claude · idle_prompt\nполе из доки",
    ],
    [
      "без notification_message — одна строка",
      JSON.stringify({ cwd: "/tmp/проба", notification_type: "auth_success" }),
      "Claude · проба · auth_success",
    ],
    [
      "пустого сообщения второй строкой нет",
      JSON.stringify({
        notification_type: "auth_success",
        notification_message: "",
      }),
      "Claude · auth_success",
    ],
    [
      "без обоих полей — один заголовок",
      JSON.stringify({ session_id: "s-2" }),
      "Claude · notification",
    ],
    [
      "незнакомый тип доезжает как есть",
      JSON.stringify({ notification_type: "совсем_новый_тип" }),
      "Claude · совсем_новый_тип",
    ],
    [
      "завершающий слэш в cwd не даёт пустого проекта",
      JSON.stringify({
        cwd: "/home/user/mr/mp/mpu/",
        notification_type: "idle_prompt",
      }),
      "Claude · mpu · idle_prompt",
    ],
    [
      "нестроковые поля считаются отсутствующими",
      JSON.stringify({
        cwd: 42,
        notification_type: null,
        notification_message: { a: 1 },
      }),
      "Claude · notification",
    ],
    [
      "незнакомые поля игнорируются",
      JSON.stringify({ future_field: true, notification_type: "idle_prompt" }),
      "Claude · idle_prompt",
    ],
  ];
  for (const [title, json, expected] of cases) {
    await t.step(title, () => {
      assertEquals(notificationText(parseHookPayload(json)), expected);
    });
  }
});

Deno.test("живой образец события хука разбирается обеими строками", async () => {
  // Образец снят живым хуком 2026-08-27 и лежит голденом канала: дока и
  // бинарь Claude Code расходятся, и сверять разбор надо с бинарём.
  const payload = await Deno.readTextFile(
    new URL(
      "./testdata/claude-hook-notification/payload-idle-prompt.json",
      import.meta.url,
    ),
  );
  assertEquals(
    notificationText(parseHookPayload(payload)),
    "Claude · ozon · idle_prompt\nClaude is waiting for your input",
  );
});

Deno.test("текст длиннее предела усекается, а не отбивается", () => {
  const long = "я".repeat(TEXT_LIMIT + 1);
  const text = notificationText(
    parseHookPayload(
      JSON.stringify({
        notification_type: "idle_prompt",
        notification_message: long,
      }),
    ),
  );
  assertEquals(text.length, TEXT_LIMIT);
  assertEquals(text.endsWith("…"), true);
  assertEquals(text.startsWith("Claude · idle_prompt\n"), true);
});

Deno.test("усечение не режет суррогатную пару пополам", () => {
  const head = "Claude · idle_prompt\n";
  // Пара приходится ровно на место среза: без учёта пар в тексте
  // осталась бы её старшая половина — не символ, а мусор.
  const message = "я".repeat(TEXT_LIMIT - head.length - 2) + "🙂🙂";
  const text = notificationText(
    parseHookPayload(
      JSON.stringify({
        notification_type: "idle_prompt",
        notification_message: message,
      }),
    ),
  );
  // Пара выброшена целиком, поэтому текст на единицу короче предела.
  assertEquals(text.length, TEXT_LIMIT - 1);
  assertEquals(text.endsWith("я…"), true);
  assertEquals(hasLoneSurrogate(text), false);
});

/** Есть ли в тексте половина суррогатной пары без своей второй. */
function hasLoneSurrogate(text: string): boolean {
  // Итератор строки отдаёт суррогатную пару одним символом, поэтому
  // всё, что осталось одиночным кодом из диапазона пар, — половина.
  return [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
  });
}

Deno.test("текст ровно по пределу не трогается", () => {
  const head = "Claude · idle_prompt\n";
  const message = "я".repeat(TEXT_LIMIT - head.length);
  const text = notificationText(
    parseHookPayload(
      JSON.stringify({
        notification_type: "idle_prompt",
        notification_message: message,
      }),
    ),
  );
  assertEquals(text.length, TEXT_LIMIT);
  assertEquals(text.endsWith("…"), false);
});

Deno.test("stdin, не разбираемый в объект, — ошибка ввода", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["пустой stdin", ""],
    ["одни пробелы", "  \n"],
    ["не JSON", "просто текст уведомления"],
    ["массив", "[1, 2]"],
    ["число", "42"],
    ["строка", '"уведомление"'],
    ["null", "null"],
  ];
  for (const [title, stdin] of cases) {
    await t.step(title, () => {
      const err = assertThrows(
        () => parseHookPayload(stdin),
        UsageError,
        "stdin хука разбирается как JSON-объект",
      );
      // Ввод в текст отказа не попадает ни куском, ни первой строкой:
      // иначе он вернулся бы в секцию `err` журнала вызовов.
      assertEquals(err.message.includes(stdin.trim()), stdin.trim() === "");
    });
  }
});
