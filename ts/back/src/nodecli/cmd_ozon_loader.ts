/**
 * Группа `mpu ozon-loader` (`docs/specs/portainer-wrappers.md`):
 * загрузка данных Ozon-кабинета в БД клиента. Шесть подкоманд
 * отличаются только методом сервиса, седьмая (`load-data`) — своим
 * входом: она грузит несколько кабинетов сразу и зашитой
 * последовательностью шагов.
 *
 * Селектор идёт после имени подкоманды — раскладка соседей семейства.
 */

import { z } from "@zod/zod";
import { type Command, defineCommand, UsageError } from "../command/mod.ts";
import {
  commonArgs,
  commonArgsOf,
  renderWrap,
  resultSchema,
  runWrap,
  type WrapIo,
} from "./run.ts";

const argsSchema = z.object({
  ...commonArgs,
  "seller-client-id": z.array(z.string()).optional().describe(
    "кабинет Ozon; у load-data флаг повторяется",
  ),
});

/**
 * Шаги загрузки `load-data` в порядке рабочей версии. Опции у списка
 * нет: он зашит и наружу не выведен — порядок шагов часть контракта
 * метода, а не выбор оператора (спека семейства, «Известные
 * отклонения»).
 */
const SEQUENCE: readonly string[] = [
  "ozonProductInfo",
  "ozonCampaigns",
  "ozonCampaignDailyStatistics",
  "ozonAttributes",
  "ozonCommonLocalizationIndex",
  "ozonAnalytics",
  "ozonFboList",
  "ozonFbsList",
  "ozonStocks",
  "ozonActions",
  "ozonPrices",
  "ozonTransactions",
  "ozonRatingBySku",
  "ozonReturns",
  "ozonCategories",
  "ozonPerformanceReports",
  "ozonSearchPromo",
  "ozonPostingsReports",
];

/** Подкоманда → метод сервиса и её однострока. */
const SUBCOMMANDS: readonly (readonly [string, string, string])[] = [
  ["postings-reports", "ozonPostingsReports", "отчёты по отправлениям"],
  ["performance-reports", "ozonPerformanceReports", "отчёты по рекламе"],
  ["search-promo", "ozonSearchPromo", "продвижение в поиске"],
  [
    "campaign-daily-statistics",
    "ozonCampaignDailyStatistics",
    "дневная статистика кампаний",
  ],
  ["campaigns", "ozonCampaigns", "рекламные кампании"],
  ["transactions", "ozonTransactions", "транзакции"],
];

/** Общая часть справки: доставка, режимы и проверка значений. */
const DELIVERY = `-p/--print ничего не выполняет: печатает готовую
ssh-команду и копирует её в буфер обмена. --local вместе с -p печатает
форму локального стенда (без ssh); сам по себе --local — ошибка ввода.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы;
--server sl-N задаёт сервер напрямую. --client-id берётся из кандидатов
селектора, если у всех кандидатов он один. --seller-client-id
обязателен и никогда не выводится автоматически: кабинет выбирает
человек.

Значения флагов проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка это ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.`;

/** Все подкоманды группы; порядок — порядок объявления в спеке. */
export const ozonLoaderCommands: readonly Command[] = [
  ...SUBCOMMANDS.map(([sub, method, what]) => loader(sub, method, what)),
  loadData(),
];

function loader(sub: string, method: string, what: string): Command {
  return defineCommand({
    path: ["ozon-loader", sub],
    summary: `Загрузить в БД клиента: ${what} (Ozon-кабинет).`,
    usage:
      `mpu ozon-loader ${sub} SELECTOR --seller-client-id S [-p [--local]]`,
    help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:ozonLoader ${method}\` и стримит его вывод,
код выхода наследуется 1:1.

${DELIVERY}

Флаг не повторяется: у этой подкоманды кабинет один. Несколько сразу
грузит mpu ozon-loader load-data.

Примеры: mpu ozon-loader ${sub} 777 --seller-client-id 999001;
mpu ozon-loader ${sub} 777 --seller-client-id 999001 -p`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "ozon-loader",
    argsSchema,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "ozonLoader",
          method,
          flags: () => [{
            name: "seller-client-id",
            value: onlySeller(args["seller-client-id"]),
          }],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}

function loadData(): Command {
  return defineCommand({
    path: ["ozon-loader", "load-data"],
    summary: "Загрузить в БД клиента все данные Ozon-кабинетов по порядку.",
    usage:
      "mpu ozon-loader load-data SELECTOR --seller-client-id S… [-p [--local]]",
    help: `По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:ozonLoader loadData\` и стримит его вывод,
код выхода наследуется 1:1. Это самый длинный вызов семейства: он
проходит восемнадцать шагов загрузки подряд.

${DELIVERY}

--seller-client-id повторяется (--seller-client-id 1 --seller-client-id
2); в inner-команду он уходит один раз именем --seller-client-ids, а
значения идут подряд отдельными токенами. Множественное число здесь не
опечатка, а имя флага метода.

Последовательность шагов зашита и опцией не управляется: восемнадцать
токенов --sequence в порядке рабочей версии.

Примеры: mpu ozon-loader load-data 777 --seller-client-id 999001;
mpu ozon-loader load-data 777 --seller-client-id 999001 -p`,
    policy: "rw",
    helpWhenBare: true,
    errorName: "ozon-loader",
    argsSchema,
    forms: { selector: { positional: "one" }, print: { short: "p" } },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "ozonLoader",
          method: "loadData",
          flags: () => [
            // Имя флага у метода — во множественном числе, у человека
            // — в единственном: так в рабочей версии, и перевод живёт
            // здесь (спека семейства, «Известные отклонения»).
            {
              name: "seller-client-ids",
              value: sellers(args["seller-client-id"]),
            },
            { name: "sequence", value: SEQUENCE },
          ],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}

/** `--seller-client-id` обязателен: без кабинета грузить нечего. */
function sellers(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined || value.length === 0) {
    throw new UsageError("нужен --seller-client-id");
  }
  return value;
}

/** У подкоманд с единственным кабинетом повтор флага — ошибка ввода. */
function onlySeller(value: readonly string[] | undefined): string {
  const list = sellers(value);
  if (list.length > 1) {
    throw new UsageError(
      "--seller-client-id повторяется только у load-data",
    );
  }
  return list[0];
}
