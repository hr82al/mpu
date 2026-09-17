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
} from "@mtcute/deno";
import { clientRefusal } from "./client_refusal.ts";
import {
  answeredWithin,
  connectWithin,
  LOGIN_ANSWER_LIMIT_MS,
} from "./connection.ts";
import { telegramCrypto } from "./crypto.ts";
import type { AppKeys, LoginClient, LoginPrompts } from "./login.ts";
import { telegramPlatform } from "./platform.ts";
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
    // Логи клиента — в stderr: stdout команды — данные (`platform.ts`).
    platform: telegramPlatform(),
    ...(proxy === undefined
      ? {}
      : { transport: proxyTransportFromUrl(proxyUrl(proxy)) }),
    disableUpdates: true,
  });
  return {
    signIn: async (phone, prompts) => {
      try {
        // Пределы — на соединение и на первый ответ входа, а не на весь
        // вход: `start` ждёт кода, который человек набирает дольше любого
        // предела. Вопрос человеку и есть знак, что первый ответ пришёл.
        await connectWithin(client);
        await answeredWithin(
          client,
          LOGIN_ANSWER_LIMIT_MS,
          (answered) =>
            client.start({
              phone: () => Promise.resolve(phone),
              // Код — обычный ввод, пароль второго фактора — скрытый
              // (спека, шаги 5 и инвариант 1). Пустой ответ библиотека
              // трактует как отсутствие: спрашивать второй раз — её дело.
              code: () => {
                answered();
                return askOr(prompts, "code from Telegram: ");
              },
              password: () => {
                answered();
                return askSecretOr(prompts, "2FA password: ");
              },
              // Ход входа от клиента — строками хода сценария: без этих
              // обработчиков библиотека печатает его прямым `console.log`,
              // мимо платформы клиента, в stdout («stdout входа»).
              codeSentCallback: (sent) => {
                // Без обработчика библиотека сама отказывает на этом виде
                // доставки; обработчик этот отказ снимает — он повторён здесь.
                if (sent.type === "email_required") {
                  throw new MtcuteError(
                    "Email login setup is required to sign in",
                  );
                }
                prompts.progress(
                  `# telegram: код подтверждения отправлен (${sent.type})`,
                );
              },
              invalidCodeCallback: (type) => {
                prompts.progress(
                  type === "code"
                    ? "# telegram: код не подошёл, попробуй ещё раз"
                    : "# telegram: пароль не подошёл, попробуй ещё раз",
                );
              },
            }),
        );
        // Строка сессии не логируется и не печатается: она уходит
        // ровно одному вызывающему — сценарию, который кладёт её в
        // env-файл.
        return sharedSessionString(await client.exportSession());
      } catch (err) {
        // Отказ клиента — строкой слоя, дальше он станет пропуском; прочее
        // уходит как есть (`telegram-login.md`, инвариант 3).
        throw clientRefusal(err);
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
