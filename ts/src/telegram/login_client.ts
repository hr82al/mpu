/**
 * Живой вход MTProto — единственное место, знающее про клиент
 * Telegram при входе (`docs/specs/telegram-login.md`).
 *
 * Модуль подгружается лениво из команды: крипта MTProto и её wasm не
 * должны попадать в старт каждого вызова `mpu` — то же рассуждение,
 * что у `session.ts`.
 *
 * **Сам вход тестами не покрыт и покрыт быть не может.** Сеть в
 * тестах запрещена, а живой вход требует настоящего телефона, кода из
 * Telegram и **отзывает действующую сессию владельца**: прогон «до
 * конца» сломал бы рабочий доступ. Проверены ветки сценария
 * (`login.ts` с двойником), формат записываемой строки сессии и отказы
 * без сети (`login_client_test.ts`): сбой криптографии и отказ, не
 * относящийся к ней, — соединение подменено отказом, клиент закрыт во
 * время попытки;
 * поведение самой библиотеки при входе не проверено ничем, и в отчёте
 * это сказано прямо.
 */

import { convertToTelethonSession } from "@mtcute/convert";
import {
  MemoryStorage,
  MtcuteError,
  proxyTransportFromUrl,
  TelegramClient,
  tl,
} from "@mtcute/deno";
import { VerbatimError, VerbatimUsageError } from "../command/mod.ts";
import { telegramCrypto } from "./crypto.ts";
import { CryptoInitError, layerFailure } from "./errors.ts";
import type { AppKeys, LoginClient, LoginPrompts } from "./login.ts";
import { type ProxySettings, proxyUrl } from "./proxy.ts";

/**
 * Открывает клиента для входа. Хранилище только в памяти: строку
 * сессии записывает сценарий в env-файл, и второго её места на диске
 * быть не должно (инвариант 2 спеки).
 */
export function openLoginClient(
  keys: AppKeys,
  proxy: ProxySettings | undefined,
): LoginClient {
  const client = new TelegramClient({
    apiId: Number(keys.apiId),
    apiHash: keys.apiHash,
    storage: new MemoryStorage(),
    // Wasm криптографии — из собранной программы, не из сети (`crypto.ts`).
    crypto: telegramCrypto(),
    ...(proxy === undefined
      ? {}
      : { transport: proxyTransportFromUrl(proxyUrl(proxy)) }),
    disableUpdates: true,
  });
  return {
    signIn: async (phone, prompts) => {
      try {
        await client.start({
          phone: () => Promise.resolve(phone),
          // Код — обычный ввод, пароль второго фактора — скрытый
          // (спека, шаги 5 и инвариант 1). Пустой ответ библиотека
          // трактует как отсутствие: спрашивать второй раз — её дело.
          code: () => askOr(prompts, "code from Telegram: "),
          password: () => askSecretOr(prompts, "2FA password: "),
        });
        // Строка сессии не логируется и не печатается: она уходит
        // ровно одному вызывающему — сценарию, который кладёт её в
        // env-файл.
        return sharedSessionString(await client.exportSession());
      } catch (err) {
        throw loginRefusal(err);
      }
    },
    close: async () => {
      await client.destroy();
    },
  };
}

/**
 * Строка сессии в том формате, в каком её читают ОБЕ реализации.
 *
 * Клиент экспортирует свой формат, а `TELEGRAM_SESSION` — внешняя
 * граница: ту же строку читает Python-версия, и наш же сеанс
 * (`session.ts`) переводит её `convertFromTelethonSession`. Записать
 * сюда родной формат клиента значило бы сломать после успешного входа
 * всё семейство разом — и наше, и прежнее.
 */
export function sharedSessionString(
  exported: Parameters<typeof convertToTelethonSession>[0],
): string {
  return convertToTelethonSession(exported);
}

/**
 * Отказ входа: строкой слоя — только отказ, пришедший от Telegram или от
 * клиента (`tl.RpcError`, `MtcuteError`, сбой криптографии, своё
 * оформление слоя); дальше он становится пропуском. Прочее — дефект своего
 * кода, отказ терминала на вопросе кода — отдаётся как есть: переоформлять
 * его в `RPC error` значило бы выдать ошибку программы за отказ Telegram
 * (`telegram-login.md`, инвариант 3). Различение — здесь, а не в
 * `errors.ts`: классы библиотеки знает только модуль, который её грузит.
 */
export function loginRefusal(err: unknown): unknown {
  const fromClient = err instanceof tl.RpcError ||
    err instanceof MtcuteError ||
    err instanceof CryptoInitError ||
    err instanceof VerbatimError ||
    err instanceof VerbatimUsageError;
  return fromClient ? layerFailure(err) : err;
}

/** Видимый вопрос; ответа нет — пустая строка, решает библиотека. */
async function askOr(prompts: LoginPrompts, question: string): Promise<string> {
  return (await prompts.ask(question)) ?? "";
}

/** Скрытый вопрос: набранное не показывается на экране. */
async function askSecretOr(
  prompts: LoginPrompts,
  question: string,
): Promise<string> {
  return (await prompts.askSecret(question)) ?? "";
}
