/**
 * Группа `mpu wb-loader` (`docs/specs/portainer-wrappers.md`): загрузка
 * данных WB-кабинета в БД клиента. Восемь подкоманд отличаются только
 * методом sl-back CLI и однострокой, поэтому объявляются одной сборкой:
 * восемь копий разъехались бы на первой же правке поверхности.
 */

import { z } from "@zod/zod";
import { type Command, defineCommand } from "../command/mod.ts";
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
  sid: z.string().describe("WB-кабинет: sid; из кандидатов не выводится"),
});

/** Подкоманда → метод сервиса и её однострока. */
const SUBCOMMANDS: readonly (readonly [string, string, string])[] = [
  ["reports", "wbReports", "отчёты WB"],
  ["cards", "wbCards", "карточки товаров"],
  [
    "adv-auto-keywords-stats",
    "wbAdvAutoKeywordsStats",
    "статистика автокампаний",
  ],
  ["adv-fullstats", "wbAdvFullstats", "полная статистика рекламы"],
  ["search-texts", "wbSearchTexts", "поисковые запросы"],
  ["analytics-by-period", "wbAnalyticsByPeriod", "аналитика за период"],
  ["adverts", "wbAdverts", "рекламные кампании"],
  ["search-clusters-bids", "wbSearchClustersBids", "ставки кластеров поиска"],
];

/** Все подкоманды группы; порядок — порядок объявления в спеке. */
export const wbLoaderCommands: readonly Command[] = SUBCOMMANDS.map(
  ([sub, method, what]) => loader(sub, method, what),
);

function loader(sub: string, method: string, what: string): Command {
  return defineCommand({
    path: ["wb-loader", sub],
    keys: {},
    summary: `Загрузить в БД клиента: ${what} (WB-кабинет).`,
    usage:
      `mpu wb-loader ${sub} [print [local]] target: СЕЛЕКТОР sid: SID [server: sl-N] [client-id: N]`,
    help: `Звать, когда в БД клиента надо догрузить ${what} одного
WB-кабинета, не дожидаясь расписания загрузчика.

По умолчанию команда ВЫПОЛНЯЕТСЯ в прод-контейнере клиента:
запускает \`node cli service:wbLoader ${method}\` и стримит его вывод,
код выхода наследуется 1:1.

print ничего не выполняет: печатает готовую ssh-команду и копирует
её в буфер обмена. local вместе с print печатает форму локального
стенда (без ssh); сам по себе local — ошибка ввода.

target: — client_id, spreadsheet_id или заголовок таблицы; server:
sl-N задаёт сервер напрямую. client-id: берётся из кандидатов цели,
если у всех кандидатов он один. sid: обязателен и никогда не выводится
автоматически: кабинет выбирает человек.

Значения ключей проверяются до сети и до печати: допустимы только
A-Za-z0-9 и _ . / : - , @ [ ] — пробел или кавычка в значении это
ошибка ввода.

Exit: код inner-команды при выполнении; 0 при печати; 2 — ошибки ввода,
резолва и конфигурации.`,
    examples: [
      `mpu wb-loader ${sub} target: 777 sid: SID42`,
      `mpu wb-loader ${sub} print target: 777 sid: SID42`,
    ],
    policy: "rw",
    // Голый вызов печатает справку, а не сообщение схемы (спека
    // семейства, «CLI-контракт»).
    helpWhenBare: true,
    // Имя в ошибках — имя группы, а не подкоманды (спека семейства).
    errorName: "wb-loader",
    argsSchema,
    forms: {
      selector: { positional: "one" },
      print: { short: "p" },
    },
    resultSchema,
    run: (args, io: WrapIo) =>
      runWrap(
        {
          service: "wbLoader",
          method,
          flags: () => [{ name: "sid", value: args.sid }],
        },
        commonArgsOf(args),
        io,
      ),
    render: renderWrap,
    textExitCode: (result) => result.exitCode,
  });
}
