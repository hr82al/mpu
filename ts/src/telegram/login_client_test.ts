/**
 * Единственное, что в живом входе проверяемо без сети: формат строки
 * сессии, которую он записывает.
 *
 * `TELEGRAM_SESSION` — внешняя граница (`platform/telegram-mtproto.md`):
 * ту же строку читают обе реализации, и наш сеанс переводит её
 * `convertFromTelethonSession` (`session.ts`). Записать туда родной
 * формат клиента значило бы сломать после успешного входа всё
 * семейство разом — а увидеть это можно было бы только живым входом,
 * который отзывает сессию владельца. Поэтому сверка здесь, на паре
 * конвертеров, а не там.
 */

import { assertEquals } from "@std/assert";
import {
  convertFromTelethonSession,
  serializeTelethonSession,
} from "@mtcute/convert";
import { sharedSessionString } from "./login_client.ts";

/** Синтетическая сессия: ключ нулевой, адрес — тестовый DC Telegram. */
const TELETHON = serializeTelethonSession({
  dcId: 2,
  ipAddress: "149.154.167.51",
  ipv6: false,
  port: 443,
  authKey: new Uint8Array(256),
});

Deno.test("вход пишет строку в формате прежней реализации, а не своём", () => {
  // Читатель ждёт формат telethon: то, что он разбирает, вход и обязан
  // записывать. Мутация «вернуть экспорт клиента как есть» краснеет
  // здесь, а не на живом входе.
  const asRead = convertFromTelethonSession(TELETHON);
  assertEquals(sharedSessionString(asRead), TELETHON);
});

Deno.test("записанное читается тем же путём, что и в сеансе", () => {
  // Круг замкнут: строка, которую вход положит в env-файл, проходит
  // ровно тот конвертер, которым её берёт `session.ts`.
  const written = sharedSessionString(convertFromTelethonSession(TELETHON));
  const parsed = convertFromTelethonSession(written);
  assertEquals(parsed.primaryDcs.main.id, 2);
  assertEquals(parsed.authKey.length, 256);
});
