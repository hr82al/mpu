/**
 * Web поверх core (`mp-init.md`, «Шаг 5…», сценарии M3): инфра SW из
 * local-stack, вход в Nexus, тег образа зависимостей sw-back и сам
 * web-стек с `--no-deps`.
 *
 * Web поднимается из compose local-stack, но не через его зависимости:
 * их роли (nats, sl-0…) уже заняты флотом mp-config-local. Поэтому всё,
 * что web ждёт от окружения, команда проверяет и готовит сама — каждый
 * шаг пробой «уже как надо?», мутация только при «нет».
 */

import { z } from "zod";
import { type Address, Page } from "./answers.ts";
import type { Docker } from "./docker.ts";
import type { Step } from "./plan.ts";

/** Конфликтующие с web-стеком контейнеры; порядок — из спеки. */
export const CONFLICTING = ["mp-sw-api", "nextjs-dev", "mp-sl-front-dev"];

/** Сеть, в которой web ждёт инфру SW (external у его compose). */
const INFRA_NETWORK = "local-stack-sw-db-net";
/** Контейнеры инфры SW: те же имена и у mp-config-local. */
const INFRA_CONTAINERS = ["mp-sw-pg", "redis-dev"];

/** Docker-реестр образа зависимостей sw-back. */
const NEXUS = "nexus.btlz-api.ru";
/** Файлы чекаута sw-back, из которых снимается тег, — по порядку. */
const DEPS_FILES = [
  "Dockerfile.deps",
  "package.json",
  "package-lock.json",
  ".npmrc",
];
/** Алиас internal-api у флота mp-config-local (`sl-0-internal-api`). */
const INTERNAL_API = "http://internal-api:5100";

/** Услуги web-стека в порядке compose-строки. */
const WEB_SERVICES = ["sw-back", "sw-front", "sl-front"];
/** Web без sw-back: вход или образ зависимостей не позволили. */
const WITHOUT_SW_BACK = ["sw-front", "sl-front"];

/** Адрес финальной проверки каждой услуги web — в порядке проверки. */
const PAGES: ReadonlyMap<string, Address> = new Map([
  ["sw-front", new Page("http://sw.localhost")],
  ["sw-back", new Page("http://sw.localhost/api/metrics")],
  ["sl-front", new Page("http://sl-dev.localhost")],
]);

/** Адреса поднятых услуг web; неподнятая не проверяется. */
export function webPages(services: readonly string[]): readonly Address[] {
  return [...PAGES].filter(([name]) => services.includes(name)).map((
    [, page],
  ) => page);
}

/** Файлы стенда, которые команда читает сама; нет файла — исключение. */
export interface StandFiles {
  readonly readText: (path: string) => string;
  readonly readBytes: (path: string) => Uint8Array;
  /** Имена в каталоге, без пути. */
  readonly listDir: (dir: string) => readonly string[];
}

/** Текст файла; нет его или не читается — пусто. */
export function textOr(files: StandFiles, path: string): string {
  try {
    return files.readText(path);
  } catch {
    // Отсутствие и отказ чтения для пробы значат одно: сведений нет.
    return "";
  }
}

/** Что нужно шагам web: пробы, печать и исполнение мутаций. */
export interface WebContext {
  readonly docker: Docker;
  readonly cwd: string;
  readonly progress: (line: string) => void;
  /** Печать `$ …` и исполнение (в `dry` — только печать); код вызова. */
  readonly perform: (step: Step) => Promise<number>;
}

/** Каталог local-stack и то, что из него берётся. */
export class LocalStack {
  /**
   * @param dir каталог local-stack
   * @param rootDir корень `mp`: там чекауты sw-back, sw-front, sl-front
   * @param files чтение файлов стенда
   */
  constructor(
    readonly dir: string,
    readonly rootDir: string,
    private readonly files: StandFiles,
  ) {}

  /** Переменные `$L/.env`; файла нет — пусто. */
  settings(): ReadonlyMap<string, string> {
    return dotEnvOf(textOr(this.files, `${this.dir}/.env`));
  }

  /**
   * Шаги инфры SW: обе в сети — ничего; иначе существующие — `rm -f`
   * (данные в именованном томе), затем compose инфры local-stack.
   */
  async infraSteps(context: WebContext): Promise<readonly Step[]> {
    const existing: string[] = [];
    let inNetwork = 0;
    for (const name of INFRA_CONTAINERS) {
      const probe = await context.docker.probe(
        ["docker", "inspect", "-f", "{{json .NetworkSettings.Networks}}", name],
        context.cwd,
      );
      if (probe.code !== 0) continue;
      existing.push(name);
      if (networksOf(probe.stdout).includes(INFRA_NETWORK)) inNetwork++;
    }
    if (inNetwork === INFRA_CONTAINERS.length) return [];
    const steps: Step[] = [];
    if (existing.length > 0) {
      steps.push({
        name: "sw-infra",
        argv: ["docker", "rm", "-f", ...existing],
        cwd: this.dir,
      });
    }
    steps.push({
      name: "sw-infra",
      argv: [
        "docker",
        "compose",
        ...this.envFileArgs(),
        "-f",
        `${this.dir}/infra/compose.sw-infra.yaml`,
        "up",
        "-d",
      ],
      cwd: this.dir,
    });
    return steps;
  }

  /**
   * `--env-file` на каждый `$L/env/*.env` в порядке имён: без них
   * compose инфры падает на пустом порте.
   */
  private envFileArgs(): string[] {
    const dir = `${this.dir}/env`;
    let names: readonly string[];
    try {
      names = this.files.listDir(dir);
    } catch {
      // Нет каталога — нет файлов; compose сам скажет, чего не хватило.
      names = [];
    }
    return names.filter((name) => name.endsWith(".env")).sort().flatMap((
      name,
    ) => ["--env-file", `${dir}/${name}`]);
  }

  /** Web-стек: окружение процесса, `--no-deps`, услуги по порядку. */
  webStep(services: readonly string[], tag: DepsTag): Step {
    const root = this.rootDir;
    return {
      name: "web",
      argv: [
        "docker",
        "compose",
        "-f",
        `${this.dir}/docker-compose.yml`,
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        ...services,
      ],
      cwd: this.dir,
      env: {
        SW_BACK_SRC: `${root}/sw-back`,
        SW_FRONT_SRC: `${root}/sw-front`,
        SL_FRONT_SRC: `${root}/sl-front`,
        ...tag.env(),
        SW_BACK_INTERNAL_API_URL: this.settings().get(
          "SW_BACK_INTERNAL_API_URL",
        ) ?? INTERNAL_API,
      },
    };
  }
}

/** Имена сетей из `{{json .NetworkSettings.Networks}}`; мусор — ни одной. */
function networksOf(json: string): readonly string[] {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(
      JSON.parse(json),
    );
    return parsed.success ? Object.keys(parsed.data) : [];
  } catch {
    // Не JSON — сетей не видно; инфра пересоздаётся, это безопасно.
    return [];
  }
}

/**
 * Строки `KEY=value` dotenv-файла; комментарии и прочее пропускаются.
 * Значение в кавычках — как есть, без них — до ` #`, как читает compose.
 */
function dotEnvOf(text: string): ReadonlyMap<string, string> {
  const settings = new Map<string, string>();
  for (const line of text.split("\n")) {
    const pair = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (pair === null) continue;
    const quoted = /^(["'])(.*)\1$/.exec(pair[2]);
    settings.set(pair[1], quoted?.[2] ?? pair[2].replace(/\s+#.*$/, ""));
  }
  return settings;
}

/** Решение о web: код отказа и услуги, которые поднимаются. */
export interface Admission {
  readonly code: number;
  readonly services: readonly string[];
}

/** Отказ: web не поднимается вовсе. */
export function refused(code: number): Admission {
  return { code, services: [] };
}

/** Web не поднимается, и это не отказ: каталога local-stack нет. */
export const NO_WEB: Admission = { code: 0, services: [] };

const WITH_SW_BACK: Admission = { code: 0, services: WEB_SERVICES };
const NO_SW_BACK: Admission = { code: 0, services: WITHOUT_SW_BACK };

/**
 * Вход в Nexus: без него образ зависимостей sw-back не скачать. Вход
 * пропускает дальше — к проверке образа (`next`) — или решает сам.
 */
export interface NexusAccess {
  enter(
    context: WebContext,
    next: () => Promise<Admission>,
  ): Promise<Admission>;
}

/** Вход уже есть в `config.json` docker'а. */
const LOGGED_IN: NexusAccess = {
  enter: (_context, next) => next(),
};

/** Входа нет, но есть `NPM_AUTH`: пароль — только в stdin. */
class Credentials implements NexusAccess {
  constructor(
    private readonly login: string,
    private readonly password: string,
  ) {}

  async enter(
    context: WebContext,
    next: () => Promise<Admission>,
  ): Promise<Admission> {
    const code = await context.perform({
      name: "nexus-login",
      argv: ["docker", "login", NEXUS, "-u", this.login, "--password-stdin"],
      cwd: context.cwd,
      stdin: this.password,
    });
    if (code === 0) return await next();
    context.progress(`mpu mp-init: вход в ${NEXUS} упал (rc=${code})`);
    return refused(code);
  }
}

/** Ни входа, ни `NPM_AUTH`: sw-back не поднимается, остальной web — да. */
class NoAccess implements NexusAccess {
  constructor(private readonly localStackDir: string) {}

  enter(context: WebContext): Promise<Admission> {
    const dir = this.localStackDir;
    context.progress(
      `warning: нет входа в ${NEXUS} и NPM_AUTH в ${dir}/.env — ` +
        `см. ${dir}/README.md, «Nexus»; sw-back не поднимаю`,
    );
    return Promise.resolve(NO_SW_BACK);
  }
}

const dockerConfigSchema = z.object({
  auths: z.record(z.string(), z.unknown()),
});

/**
 * Каким путём войти в Nexus: по `config.json` docker'а (его текст —
 * `dockerConfig`) и `NPM_AUTH` из `$L/.env`.
 */
export function nexusAccessOf(
  dockerConfig: string,
  stack: LocalStack,
): NexusAccess {
  if (hasNexusAuth(dockerConfig)) return LOGGED_IN;
  const npmAuth = stack.settings().get("NPM_AUTH") ?? "";
  return credentialsOf(npmAuth, new NoAccess(stack.dir));
}

function hasNexusAuth(dockerConfig: string): boolean {
  try {
    const parsed = dockerConfigSchema.safeParse(JSON.parse(dockerConfig));
    return parsed.success && Object.hasOwn(parsed.data.auths, NEXUS);
  } catch {
    // Нет файла или не JSON — входа не видно.
    return false;
  }
}

/**
 * `NPM_AUTH` — base64 `логин:пароль`; иначе входа по нему нет, и
 * отвечает `none`.
 */
function credentialsOf(npmAuth: string, none: NexusAccess): NexusAccess {
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(npmAuth), (char) => char.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Не base64 или не UTF-8 — то же, что отсутствие (M3-14).
    return none;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0 || colon === decoded.length - 1) return none;
  return new Credentials(decoded.slice(0, colon), decoded.slice(colon + 1));
}

/**
 * Тег образа зависимостей sw-back: пускает sw-back, если образ есть в
 * реестре, и отдаёт web своё окружение.
 */
export interface DepsTag {
  admit(context: WebContext): Promise<Admission>;
  env(): Readonly<Record<string, string>>;
}

/** Тег снят: проверить образ в реестре. */
class KnownTag implements DepsTag {
  constructor(private readonly tag: string) {}

  async admit(context: WebContext): Promise<Admission> {
    const probe = await context.docker.probe([
      "docker",
      "manifest",
      "inspect",
      `${NEXUS}/base-images/sw-back-deps:${this.tag}`,
    ], context.cwd);
    if (probe.code === 0) return WITH_SW_BACK;
    context.progress(
      `warning: sw-back: нет образа зависимостей под этот lock (${this.tag})`,
    );
    return NO_SW_BACK;
  }

  env() {
    return { SW_BACK_DEPS_TAG: this.tag };
  }
}

/** Тег не снят: нет одного из файлов чекаута sw-back. */
class MissingTag implements DepsTag {
  constructor(private readonly path: string) {}

  admit(context: WebContext): Promise<Admission> {
    context.progress(
      `warning: sw-back: тег зависимостей не снят — нет ${this.path}; ` +
        "sw-back не поднимаю",
    );
    return Promise.resolve(NO_SW_BACK);
  }

  env() {
    return {};
  }
}

/**
 * Тег по формуле CI sw-back: первые 16 hex sha256 от байтов четырёх
 * файлов, склеенных по порядку.
 */
export async function depsTagOf(
  files: StandFiles,
  swBackDir: string,
): Promise<DepsTag> {
  const parts: Uint8Array[] = [];
  for (const name of DEPS_FILES) {
    const path = `${swBackDir}/${name}`;
    try {
      parts.push(files.readBytes(path));
    } catch {
      // Любой отказ чтения — тега нет; путь назовёт предупреждение.
      return new MissingTag(path);
    }
  }
  const whole = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", whole));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0"));
  return new KnownTag(hex.join("").slice(0, 16));
}
