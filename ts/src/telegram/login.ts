/**
 * Сценарий входа `mpu telegram login` (`docs/specs/telegram-login.md`).
 * Здесь вся логика веток и ни одного обращения к Telegram: сам вход —
 * за портом `LoginClient`, и потому каждая ветка проверяется без сети.
 *
 * Главное свойство модуля — то, чего он НЕ делает: строка сессии не
 * попадает ни в один текст, который команда печатает или отдаёт
 * дальше. Она идёт только в env-файл (инвариант 1 спеки).
 *
 * Ни один отказ сценария не даёт ненулевого кода: та же реализация —
 * шаг входа в `mpu init`, и падение на ней сломало бы bootstrap тому,
 * кто просто не хочет настраивать Telegram (инвариант 3, исправлен по
 * замеру оригинала 2026-08-31).
 */

import type { EnvFile, TerminalIo } from "../command/mod.ts";

/** Ключи env-файла, которыми распоряжается вход. */
export const SESSION_KEY = "TELEGRAM_SESSION";
export const API_ID_KEY = "TELEGRAM_API_ID";
export const API_HASH_KEY = "TELEGRAM_API_HASH";
export const PHONE_KEY = "TELEGRAM_PHONE";

/** Что вход спрашивает у человека. */
export interface LoginPrompts {
  /** Вопрос с видимым ответом; ответа нет — `undefined`. */
  readonly ask: (question: string) => Promise<string | undefined>;
  /** Вопрос со скрытым ответом: пароль второго фактора. */
  readonly askSecret: (question: string) => Promise<string | undefined>;
}

/** Живой вход в Telegram — единственное, чего нет в этом модуле. */
export interface LoginClient {
  /**
   * Проводит вход и возвращает строку сессии. Код и пароль клиент
   * спрашивает сам через переданные функции: их порядок и число
   * попыток задаёт протокол, а не мы.
   */
  readonly signIn: (
    phone: string,
    prompts: LoginPrompts,
  ) => Promise<string>;
  readonly close: () => Promise<void>;
}

/** Ключи приложения Telegram. */
export interface AppKeys {
  readonly apiId: string;
  readonly apiHash: string;
}

/** Порт сценария. */
export interface LoginIo {
  readonly envFile: Pick<EnvFile, "get" | "set">;
  /** Терминал для вопросов; `undefined` — ввод не с терминала. */
  readonly terminal: TerminalIo | undefined;
  /** Служебная строка хода: печатается в stderr точкой входа. */
  readonly progress: (line: string) => void;
  /** Открывает клиента входа; зовётся только когда до входа дошло. */
  readonly openClient: (keys: AppKeys) => Promise<LoginClient>;
}

/**
 * Исход входа: что команда сделала и чего не сделала. Размеченное
 * объединение, а не поле-опция: у пропуска причина есть всегда, и
 * защитного «без причины» у вызывающего быть не должно.
 */
export type LoginResult =
  | { readonly status: "already" | "logged-in" }
  /** Причина — та же строка, что и в `# telegram: пропущено`. */
  | { readonly status: "skipped"; readonly reason: string };

/** Где взять ключи приложения — текст спеки, дословно. */
const KEYS_HINT = "https://my.telegram.org/apps";

const SKIP_NO_TTY = "нет TTY; заполни TELEGRAM_API_ID/HASH в .env вручную";
const SKIP_LATER =
  "позже: заполнить TELEGRAM_API_ID/HASH в .env и `mpu telegram login`";
const SKIP_EMPTY = "api_id/api_hash пустые";
const SKIP_NOT_NUMBER = "api_id не целое число";

/** Непустое значение ключа env-файла; пустое равнозначно незаданному. */
function value(io: LoginIo, name: string): string | undefined {
  const raw = io.envFile.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

/** Пропуск с причиной: строка на экран и та же причина в результате. */
function skip(io: LoginIo, reason: string): LoginResult {
  io.progress(`# telegram: пропущено (${reason})`);
  return { status: "skipped", reason };
}

/** Вопросы поверх терминала: видимый и скрытый ответ. */
function promptsOn(terminal: TerminalIo): LoginPrompts {
  return {
    ask: async (question) => {
      await terminal.write(question);
      return await terminal.readLine();
    },
    askSecret: async (question) => {
      await terminal.write(question);
      return await terminal.readSecret();
    },
  };
}

/** Ключи получены — либо сценарий кончился пропуском со своей причиной. */
type KeysOutcome =
  | { readonly ok: true; readonly keys: AppKeys }
  | { readonly ok: false; readonly result: LoginResult };

/**
 * Ключи приложения: из env-файла либо у человека, с его согласия.
 * Причина пропуска возвращается вместе с исходом, а не теряется по
 * дороге: она — часть результата команды, а не только строка на экран.
 */
async function appKeys(
  io: LoginIo,
  prompts: LoginPrompts,
): Promise<KeysOutcome> {
  const apiId = value(io, API_ID_KEY);
  const apiHash = value(io, API_HASH_KEY);
  if (apiId !== undefined && apiHash !== undefined) {
    return { ok: true, keys: { apiId, apiHash } };
  }
  io.progress(`# telegram: ключей приложения нет; взять их — ${KEYS_HINT}`);
  const agreed = await prompts.ask("Set up Telegram now? [y/N]: ");
  if ((agreed ?? "").trim().toLowerCase() !== "y") {
    return { ok: false, result: skip(io, SKIP_LATER) };
  }
  const enteredId = (await prompts.ask("api_id (integer): ") ?? "").trim();
  const enteredHash = (await prompts.ask("api_hash (32 hex chars): ") ?? "")
    .trim();
  if (enteredId === "" || enteredHash === "") {
    // Пустой ввод — не отказ: код 0 и ни байта в env-файл (замер
    // оригинала 2026-08-31, инвариант 3).
    return { ok: false, result: skip(io, SKIP_EMPTY) };
  }
  if (!/^\d+$/.test(enteredId)) {
    // Нечисловой `api_id` записывать нельзя: ключ обязан быть числом
    // (`platform/telegram-mtproto.md`), а записанный мусор перестал бы
    // спрашиваться и ронял бы каждый следующий вход, пока оператор не
    // отредактирует .env руками. Пропуск, а не отказ: код 0 у всего
    // сценария (инвариант 3).
    return { ok: false, result: skip(io, SKIP_NOT_NUMBER) };
  }
  await io.envFile.set(API_ID_KEY, enteredId);
  await io.envFile.set(API_HASH_KEY, enteredHash);
  return { ok: true, keys: { apiId: enteredId, apiHash: enteredHash } };
}

/** Телефон: из env-файла либо у человека, и тогда он сохраняется. */
async function phone(
  io: LoginIo,
  prompts: LoginPrompts,
): Promise<string | undefined> {
  const saved = value(io, PHONE_KEY);
  if (saved !== undefined) return saved;
  const entered = (await prompts.ask("phone (+7…): ") ?? "").trim();
  if (entered === "") return undefined;
  // Телефон переживает неудачный вход намеренно: он не секрет доступа
  // (инвариант 2 спеки).
  await io.envFile.set(PHONE_KEY, entered);
  return entered;
}

/**
 * Исполняет сценарий. Порядок веток не косметический: сессия и TTY
 * проверяются до того, как появится клиент, поэтому ни один отказ не
 * доходит до сети — на этом же держится проверяемость команды без
 * настоящего Telegram.
 */
export async function runLogin(io: LoginIo): Promise<LoginResult> {
  if (value(io, SESSION_KEY) !== undefined) {
    // Повторный вход отзывает прежнюю сессию, поэтому идемпотентность
    // здесь — защита, а не удобство (спека, шаг 1).
    io.progress("# telegram: уже авторизован");
    return { status: "already" };
  }
  if (io.terminal === undefined) return skip(io, SKIP_NO_TTY);
  const prompts = promptsOn(io.terminal);
  const keys = await appKeys(io, prompts);
  if (!keys.ok) return keys.result;
  const number = await phone(io, prompts);
  if (number === undefined) return skip(io, "телефон не введён");
  const client = await io.openClient(keys.keys);
  try {
    const session = await client.signIn(number, prompts);
    // Единственное место, куда уходит строка сессии.
    await io.envFile.set(SESSION_KEY, session);
    io.progress("# telegram: вход выполнен, сессия записана в env-файл");
    return { status: "logged-in" };
  } finally {
    await client.close();
  }
}
