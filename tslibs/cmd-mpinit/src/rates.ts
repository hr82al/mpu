/**
 * Курсы валют на свежем стенде (`mp-init.md`, «После core — курсы
 * валют», сценарии M2): `shared.currency_rates` пуста до расписания
 * парсера, и всё, что считает деньги в валюте, врёт.
 *
 * Пуста таблица на main — main заполняет её backfill'ом, инстансы
 * тянут историю с main. Что делает стек, решает его роль в кортеже
 * core (`plan.ts`), а не ветка по имени.
 */

import { shellCommand } from "@mpu/exec";
import type { Docker, ProcessOutcome } from "./docker.ts";

/** Сервер main: на нём таблица курсов заполняется, с него — проба. */
const MAIN_SERVER = "sl-0";

/** Что нужно шагу: проба, печать и исполнение мутаций. */
export interface RatesContext {
  readonly docker: Docker;
  readonly progress: (line: string) => void;
  readonly cwd: string;
  /** В `dry` проба выполняется, а строки пропуска нет (решение хоста). */
  readonly dryRun: boolean;
  /**
   * Печать `$ …` и исполнение с выводом; в `dry` — только печать и
   * пустой итог с кодом 0.
   */
  readonly perform: (
    argv: readonly [string, ...string[]],
  ) => Promise<ProcessOutcome>;
}

/** Роль стека в заполнении курсов; 0 — порядок, иначе код выхода. */
export interface CurrencyRates {
  fill(context: RatesContext): Promise<number>;
}

/** Стек без курсов (nats, nginx, dt-host). */
export const NO_RATES: CurrencyRates = {
  fill: () => Promise.resolve(0),
};

/** `node cli` в cli-контейнере сервера. */
function cliArgv(
  server: string,
  ...args: readonly string[]
): [string, ...string[]] {
  return ["docker", "exec", `${server}-cli`, "node", "cli", ...args];
}

/** Main: backfill из ЦБ; дни с сетевой ошибкой он пропускает. */
export class MainRates implements CurrencyRates {
  async fill(context: RatesContext): Promise<number> {
    const outcome = await context.perform(
      cliArgv(MAIN_SERVER, "service:currenciesRatesParser", "backfill"),
    );
    if (outcome.code !== 0) {
      context.progress(
        `mpu mp-init: курсы валют — backfill упал (rc=${outcome.code}); ` +
          "web не поднимаю",
      );
      return outcome.code;
    }
    const days = skippedDaysOf(`${outcome.stdout}\n${outcome.stderr}`);
    if (days.length === 0) return 0;
    const catchUp = cliArgv(
      MAIN_SERVER,
      "service:currenciesRatesParser",
      "loadData",
      "--date-from",
      "D",
      "--date-to",
      "D",
    );
    context.progress(
      `warning: курсы валют — пропущены дни ${days.join(", ")}: ` +
        `догнать ${shellCommand(catchUp)}`,
    );
    return 0;
  }
}

/** Инстанс: полная история с main (`syncFromMain` берёт неделю). */
export class InstanceRates implements CurrencyRates {
  constructor(private readonly server: string) {}

  async fill(context: RatesContext): Promise<number> {
    const outcome = await context.perform(
      cliArgv(this.server, "service:currencyRatesSync", "syncFullHistory"),
    );
    if (outcome.code === 0) return 0;
    context.progress(
      `mpu mp-init: курсы валют — syncFullHistory ${this.server} упал ` +
        `(rc=${outcome.code}); web не поднимаю`,
    );
    return outcome.code;
  }
}

/** Дни строк `backfill: <дата> error …` — по порядку, без повторов. */
function skippedDaysOf(log: string): readonly string[] {
  const days = log.matchAll(/^backfill: (\d{4}-\d{2}-\d{2}) error/gm);
  return [...new Set([...days].map((match) => match[1]))];
}

/**
 * Проба и заполнение: пусто — роли по порядку кортежа (main раньше
 * инстансов), иначе пропуск. Возвращает код отказа либо 0.
 */
export async function fillRates(
  roles: readonly CurrencyRates[],
  context: RatesContext,
): Promise<number> {
  const probe = await context.docker.probe(
    [
      "docker",
      "exec",
      `${MAIN_SERVER}-pg`,
      "sh",
      "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc ' +
        '"select count(*) from shared.currency_rates"',
    ],
    context.cwd,
  );
  return await stateOf(probe).act(roles, context);
}

/** Что показала проба: сам решает, что делать дальше. */
interface RatesState {
  act(roles: readonly CurrencyRates[], context: RatesContext): Promise<number>;
}

function stateOf(probe: ProcessOutcome): RatesState {
  const count = probe.stdout.trim();
  if (probe.code !== 0 || !/^\d+$/.test(count)) return UNPROBED;
  return Number(count) === 0 ? EMPTY : new Present(count);
}

/** Проба не снята: заполнять вслепую нельзя, стенд поднимается дальше. */
const UNPROBED: RatesState = {
  act(_roles, context) {
    context.progress("warning: курсы валют — проба не удалась, шаг пропущен");
    return Promise.resolve(0);
  },
};

/** Таблица пуста: каждая роль заполняет своё, отказ — сразу наружу. */
const EMPTY: RatesState = {
  async act(roles, context) {
    context.progress("курсы валют пусты — заполняю (~10 мин)");
    for (const role of roles) {
      const code = await role.fill(context);
      if (code !== 0) return code;
    }
    return 0;
  },
};

/** Курсы есть: заполнять нечего. */
class Present implements RatesState {
  constructor(private readonly count: string) {}

  act(_roles: readonly CurrencyRates[], context: RatesContext) {
    if (!context.dryRun) {
      context.progress(`курсы валют: ${this.count} строк — пропуск`);
    }
    return Promise.resolve(0);
  }
}
