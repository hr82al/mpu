/**
 * Учётные данные прокси вне текстов отказа
 * (`docs/specs/platform/telegram-questions.md`, «Уточнения R1a»): пароль
 * с `'` и пробелом, литеральное «@», неразбираемый адрес; хост и порт
 * остаются.
 */

import { describe, expect, it } from "vitest";
import { withoutCredentials } from "./credentials.ts";

describe("адрес прокси без учётных данных", () => {
  for (const [raw, shown] of [
    ["http://u:p'a ss@h:1", "http://h:1/"],
    ["http://u:p'a ss@h", "http://h/"],
    ["socks4://u:p'a ss@h:1", "socks4://h:1"],
    ["socks5://user:pa@s3cret@10.0.0.1", "socks5://10.0.0.1"],
    ["socks5:/user:s3cret@10.0.0.1:1080", "socks5://10.0.0.1:1080"],
    ["http://u:p'a ss@[h:1", "[h:1"],
    ["http://h:1", "http://h:1/"],
  ]) {
    it(raw, () => expect(withoutCredentials(raw)).toStrictEqual(shown));
  }
});
