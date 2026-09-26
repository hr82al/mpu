/**
 * Сообщения `call-ro` и `call` получателя-маркетплейса
 * (`docs/specs/call.md`, «CLI-контракт»): объявление команды над общим
 * ходом вызова. Хост, авторизацию и умолчания знает получатель; чтение
 * или запись — допуск; справку о ключах и выводе строит одна функция.
 */

import { defineCommand, record } from "../command/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { denoSession } from "../sql/mod.ts";
import type { Access } from "./access.ts";
import {
  callExitCode,
  type CallOutcome,
  callRecord,
  renderCall,
  resultSchema,
} from "./reply.ts";
import { type CallArgs, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } from "./args.ts";
import { type CallDeps, type Marketplace, runCall } from "./run.ts";

/** Живое внешнее: сеть, часы, read-only сессия PG. */
const LIVE: CallDeps = {
  fetch: (request) => fetch(request),
  deadline: (ms) => AbortSignal.timeout(ms),
  now: () => performance.now(),
  openSession: denoSession("read-only"),
};

/** Части справки, которые знает только получатель. */
export interface ReceiverHelp {
  /** Чем назван кабинет в `cabinet:` и в отказе: `Client-Id`. */
  readonly cabinetId: string;
  /** Абзац о том, откуда ключ и куда он не выходит. */
  readonly key: string;
  /** Строка ключа `body:`: тело по умолчанию и метод. */
  readonly body: string;
  /** Сколько запросов уходит на один вызов — начало фразы о повторах. */
  readonly requests: string;
  /**
   * Продолжение фразы «dry — запрос с …» до слов «без сети»: что стоит
   * вместо секрета и чего ещё `dry` не делает.
   */
  readonly dry: string;
  /** Отказы ввода и конфигурации сверх общих — хвостом абзаца Exit. */
  readonly refusals: string;
}

/** Получатель глазами объявления: что он знает и как о нём сказать. */
export interface Receiver {
  readonly marketplace: Marketplace;
  readonly help: ReceiverHelp;
}

/** Общая часть справки обоих сообщений: ключи, вывод, коды. */
function keysHelp(receiver: Receiver): string {
  const { marketplace, help } = receiver;
  return `target: — клиент: client_id, имя или часть (поиск по кэшу), dev:<client_id>.
${help.key}
cabinet: — ${help.cabinetId} кабинета; у клиента один кабинет — можно опустить,
несколько — обязателен (отказ перечисляет ${help.cabinetId}).
${marketplace.address.help}
${help.body}
method: — GET или POST. timeout: — секунды ожидания, 1…${MAX_TIMEOUT_S}, умолчание ${DEFAULT_TIMEOUT_S}.

Вывод: HTTP <статус> <метод> <хост><путь>, строки заголовков квоты
(${marketplace.quotaHeaders.join(", ")} — если присланы), пустая строка, тело
(JSON — с отступами). ${GRAMMAR.close} json — одна строка: status, method,
url, ms, headers, body. dry — запрос с ${help.dry} без сети.
${help.requests}, повторов нет ни на 429, ни на 5xx; каждый вызов
тратит квоту кабинета клиента. В журнал вызовов тело ответа не пишется —
только статус, размер тела и заголовки квоты.

Exit: 0 — ответ 2xx и dry; 1 — ответ не 2xx, нет ответа за timeout:,
сетевой сбой; 2 — ошибка ввода и конфигурации: нет кабинета, несколько
кабинетов без cabinet:, ${help.refusals}body: не JSON, тело у GET, timeout: вне 1…${MAX_TIMEOUT_S}`;
}

/** Ключи строки использования. */
function usageKeys(receiver: Receiver): string {
  const cabinet = receiver.help.cabinetId.toUpperCase();
  return `target: КЛИЕНТ [cabinet: ${cabinet}] ` +
    `${receiver.marketplace.address.usage} [body: JSON] [method: GET|POST] ` +
    `[timeout: СЕК] [${GRAMMAR.close} json]`;
}

/** Одно сообщение получателя: объявление над общим ходом вызова. */
export function callMessage(receiver: Receiver, declared: {
  readonly name: string;
  readonly policy: "ro" | "rw";
  readonly access: Access;
  readonly summary: string;
  readonly help: string;
  readonly examples: readonly string[];
}) {
  const { marketplace } = receiver;
  const path = [...marketplace.path, declared.name];
  return defineCommand({
    path,
    errorName: path.join(" "),
    summary: declared.summary,
    usage: `mpu ${path.join(" ")} [dry] ${usageKeys(receiver)}`,
    help: `${declared.help}\n\n${keysHelp(receiver)}`,
    examples: declared.examples,
    keys: { target: "selector" },
    texts: [marketplace.address.key, "body"],
    policy: declared.policy,
    // Тело ответа — данные кабинета клиента: журнал хранит вызов,
    // статус и квоту (строкой note), но не сам ответ (спека [D.3]).
    logsStdout: false,
    argsSchema: marketplace.address.argsSchema,
    resultSchema,
    run: async (args: CallArgs, io) => ({
      call: await runCall(args, io, LIVE, {
        marketplace,
        access: declared.access,
      }),
    }),
    data: record((result: CallOutcome) => callRecord(result.call)),
    render: (result: CallOutcome) => renderCall(result.call),
    textExitCode: (result: CallOutcome) => callExitCode(result.call),
  });
}
