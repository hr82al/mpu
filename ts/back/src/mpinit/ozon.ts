/**
 * Стенд вертикали ozon (`mp-init.md`, «Шаг 6», сценарии M4): отдельный
 * compose-проект local-stack, поднимаемый после web, если есть чекаут
 * `ozon`.
 *
 * Каждый шаг идемпотентен пробой: пакет `@sw-back/workspace-access`
 * публикуется, только если нужной версии нет в Verdaccio стенда, а
 * зависимости ставятся, только если в чекауте нет `node_modules`.
 * Миграции (dbmate) идемпотентны сами и идут всегда.
 */

import { type Address, Page } from "./answers.ts";
import type { Step } from "./plan.ts";
import type { WebContext } from "./web.ts";

/** Контейнер разработки стенда: в нём node, git и оба чекаута. */
const DEV = "ozon-dev";
/** Реестр стенда, как его видит контейнер разработки. */
const VERDACCIO = "http://verdaccio:4873";
/** Пакет sw-back, которого нет в публичном npm. */
const PACKAGE = "@sw-back/workspace-access";
/** Исходники пакета в чекауте sw-back. */
const PACKAGE_DIR = "packages/workspace-access";
/** Чекаут sw-back внутри контейнера разработки. */
const SW_BACK = "/work/sw-back";
/** Куда в контейнере распаковывается коммит sw-back с пакетом. */
const ARCHIVE = "/tmp/wa";
/** Пакет внутри распакованного. */
const UNPACKED = `${ARCHIVE}/${PACKAGE_DIR}`;

/** Что нужно шагу: как web, плюс режим — проба `dist` вне `dry`. */
export interface OzonContext extends WebContext {
  readonly dryRun: boolean;
}

/** Стенд ozon: поднимается сам и называет адреса своей проверки. */
export interface OzonStand {
  /** 0 — поднят (или пропущен), иначе код выхода команды. */
  up(context: OzonContext): Promise<number>;
  /** Адреса финальной проверки; стенда нет — ни одного. */
  readonly addresses: readonly Address[];
}

/** Стенда нет: строка о пропуске, проверять нечего. */
export class NoOzon implements OzonStand {
  readonly addresses: readonly Address[] = [];

  /** @param reason строка оператору — почему шаг пропущен */
  constructor(private readonly reason: string) {}

  up(context: OzonContext): Promise<number> {
    context.progress(this.reason);
    return Promise.resolve(0);
  }
}

/** Чекаут `ozon` есть: compose `$L/ozon` поднимается по шагам. */
export class Ozon implements OzonStand {
  readonly addresses: readonly Address[] = [
    new Page("http://localhost:5200/health"),
    new Page("http://localhost:3100/ozon/app/"),
  ];

  /**
   * @param localStackDir каталог local-stack
   * @param lockText текст `pnpm-lock.yaml` чекаута; нет файла — пусто
   * @param installed есть ли `node_modules` в чекауте
   */
  constructor(
    private readonly localStackDir: string,
    private readonly lockText: string,
    private readonly installed: boolean,
  ) {}

  async up(context: OzonContext): Promise<number> {
    const steps = [
      () => this.#compose(context, ["up", "-d", ...INFRA]),
      () => packageOf(this.lockText).publish(context),
      () => this.#install(context),
      () =>
        this.#compose(context, [
          "--profile",
          "migrate",
          "run",
          "--rm",
          "migrate",
        ]),
      () => this.#compose(context, ["up", "-d", ...SERVICES]),
    ];
    for (const step of steps) {
      const code = await step();
      if (code !== 0) return code;
    }
    return 0;
  }

  /** `docker compose -f $L/ozon/docker-compose.yml …`; упал — отказ. */
  async #compose(context: OzonContext, tail: string[]): Promise<number> {
    return await performed(context, {
      name: "ozon",
      argv: [
        "docker",
        "compose",
        "-f",
        `${this.localStackDir}/ozon/docker-compose.yml`,
        ...tail,
      ],
      cwd: this.localStackDir,
    });
  }

  /** Зависимости и сборка — только когда `node_modules` нет. */
  async #install(context: OzonContext): Promise<number> {
    if (this.installed) return 0;
    for (const script of INSTALL) {
      const code = await performed(context, inDev(context, script));
      if (code !== 0) return code;
    }
    return 0;
  }
}

/** Инфра стенда и контейнер разработки — до пакета и сборки. */
const INFRA = ["pg", "redis", "clickhouse", "verdaccio", "dev"];
/** Сервисы стенда: запускают собранный `dist`. */
const SERVICES = ["datacore", "datacore-worker", "ingest", "front"];
/** pnpm после corepack не на PATH — каждая строка его добавляет. */
const PNPM = "PATH=/tmp/bin:$PATH pnpm";
/** Установка и сборка в рабочем каталоге контейнера (`/work/ozon`). */
const INSTALL = [
  "mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin",
  `${PNPM} install --config.@sw-back:registry=${VERDACCIO}`,
  `${PNPM} --filter "./packages/*" run build`,
  `${PNPM} --filter @ozon/datacore build`,
  `${PNPM} --filter @ozon/ingest build`,
];

/** Шаг-скрипт в контейнере разработки: `docker exec ozon-dev sh -c …`. */
function inDev(context: OzonContext, script: string): Step {
  return {
    name: "ozon",
    argv: ["docker", "exec", DEV, "sh", "-c", script],
    cwd: context.cwd,
  };
}

/** Шаг с проверкой кода: упал — строка отказа и его код. */
async function performed(context: OzonContext, step: Step): Promise<number> {
  const code = await context.perform(step);
  if (code !== 0) context.progress(`mpu mp-init: стенд ozon упал (rc=${code})`);
  return code;
}

/** Пакет из lock: публикуется сам или объясняет, почему нет. */
interface LockedPackage {
  publish(context: OzonContext): Promise<number>;
}

/** Версии пакета в lock нет: публиковать нечего, стенд — дальше. */
const UNLOCKED: LockedPackage = {
  publish: (context) => {
    context.progress(
      `warning: стенд ozon: в pnpm-lock нет ${PACKAGE} — публикацию пропускаю`,
    );
    return Promise.resolve(0);
  },
};

/** Ключ секции `packages` lock'а: `  '@sw-back/workspace-access@<v>':`. */
const LOCK_KEY = /^ {2}'@sw-back\/workspace-access@([^'(]+)':$/m;

/** Пакет той версии, что в lock; нет ключа — `UNLOCKED`. */
function packageOf(lockText: string): LockedPackage {
  const version = LOCK_KEY.exec(lockText)?.[1];
  return version === undefined ? UNLOCKED : new VersionedPackage(version);
}

/** Пакет версии lock: есть в Verdaccio — ничего, нет — сборка и публикация. */
class VersionedPackage implements LockedPackage {
  constructor(private readonly version: string) {}

  async publish(context: OzonContext): Promise<number> {
    const view = await probe(context, [
      "npm",
      "view",
      `${PACKAGE}@${this.version}`,
      "--registry",
      VERDACCIO,
    ]);
    if (view.code === 0) return 0;
    const commit = await this.#commit(context);
    if (commit === undefined) {
      context.progress(
        `mpu mp-init: стенд ozon: нет коммита sw-back с ${PACKAGE}@${this.version}`,
      );
      return 1;
    }
    context.progress(
      `стенд ozon: публикую ${PACKAGE}@${this.version} в Verdaccio`,
    );
    return await this.#build(context, commit);
  }

  /**
   * Коммит sw-back, где `package.json` пакета имеет эту версию. `-S`
   * отдаёт и коммит, где версию сняли бампом, — поэтому берётся первый,
   * в чьём файле она есть.
   */
  async #commit(context: OzonContext): Promise<string | undefined> {
    const marker = `"version": "${this.version}"`;
    const log = await probe(context, [
      "git",
      "-C",
      SW_BACK,
      "log",
      "--format=%H",
      `-S${marker}`,
      "--",
      `${PACKAGE_DIR}/package.json`,
    ]);
    if (log.code !== 0) return undefined;
    for (const commit of log.stdout.split("\n").filter((line) => line !== "")) {
      const show = await probe(context, [
        "git",
        "-C",
        SW_BACK,
        "show",
        `${commit}:${PACKAGE_DIR}/package.json`,
      ]);
      if (show.code === 0 && show.stdout.includes(marker)) return commit;
    }
    return undefined;
  }

  /** Распаковка коммита, `tsc`, проверка `dist`, публикация. */
  async #build(context: OzonContext, commit: string): Promise<number> {
    const unpacked = await performed(
      context,
      inDev(
        context,
        `rm -rf ${ARCHIVE} && mkdir ${ARCHIVE} && ` +
          `git -C ${SW_BACK} archive ${commit} ${PACKAGE_DIR} | tar -x -C ${ARCHIVE}`,
      ),
    );
    if (unpacked !== 0) return unpacked;
    // Код tsc не смотрится: типов Nest в пакете нет, и `Cannot find
    // module '@nestjs/common'` — ожидаемый отказ, эмиту не мешающий.
    // Судит о сборке проба `dist` ниже.
    await context.perform(
      inPackage(context, [
        "npx",
        "-y",
        "-p",
        "typescript@5",
        "tsc",
        "-p",
        "tsconfig.json",
      ]),
    );
    if (!context.dryRun && !await builtIn(context)) {
      context.progress(
        "mpu mp-init: стенд ozon: dist пакета пуст — не публикую",
      );
      return 1;
    }
    return await performed(
      context,
      inPackage(context, [
        "npm",
        "publish",
        "--registry",
        VERDACCIO,
        "--//verdaccio:4873/:_authToken=local-stand",
      ]),
    );
  }
}

/** Команда в распакованном пакете: `docker exec -w <пакет> ozon-dev …`. */
function inPackage(context: OzonContext, command: readonly string[]): Step {
  return {
    name: "ozon",
    argv: ["docker", "exec", "-w", UNPACKED, DEV, ...command],
    cwd: context.cwd,
  };
}

/** Собрал ли tsc хоть что-то: без `dist` npm издаст пакет без кода. */
async function builtIn(context: OzonContext): Promise<boolean> {
  const list = await probe(context, ["ls", `${UNPACKED}/dist`]);
  return list.code === 0 && list.stdout.trim() !== "";
}

/** Проба в контейнере разработки — без печати. */
function probe(context: OzonContext, command: readonly string[]) {
  return context.docker.probe(["docker", "exec", DEV, ...command], context.cwd);
}
