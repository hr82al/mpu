/**
 * Образы стенда: недостающий собирается той же командой, что
 * build-алиас mp-config-local (`mp-init.md`, «Подъём с нуля», шаг 3).
 *
 * Ключ идемпотентности — наличие тега: есть тег — сборки нет, без
 * сравнения с исходниками (пересборку по зависимостям делает владелец).
 */

import type { Docker } from "./docker.ts";
import type { Step } from "./plan.ts";

/** Образ, который команда умеет собрать сама. */
export class StandImage {
  /**
   * @param tag тег образа
   * @param dockerfile путь Dockerfile от каталога mp-config-local
   * @param context каталог контекста сборки: от корня `mp` либо от
   *   mp-config-local
   * @param [stage=[]] аргументы стадии сборки (`--target dev`)
   */
  constructor(
    readonly tag: string,
    private readonly dockerfile: string,
    private readonly context: (dirs: StandDirs) => string,
    private readonly stage: readonly string[] = [],
  ) {}

  /** Шаг сборки: argv — литерал build-алиаса, cwd — mp-config-local. */
  buildStep(dirs: StandDirs): Step {
    return {
      name: `build ${this.tag}`,
      cwd: dirs.configDir,
      argv: [
        "docker",
        "build",
        "--load",
        ...this.stage,
        "-t",
        this.tag,
        "-f",
        `${dirs.configDir}/${this.dockerfile}`,
        this.context(dirs),
      ],
    };
  }
}

/** Каталоги, от которых строятся пути сборки. */
export interface StandDirs {
  /** Каталог mp-config-local. */
  readonly configDir: string;
  /** Корень `mp` — родитель mp-config-local. */
  readonly rootDir: string;
}

/** Три core-образа в порядке проверки. */
export const CORE_IMAGES: readonly StandImage[] = [
  new StandImage("mp-back:local", "Dockerfile.mp-back", (d) => d.rootDir),
  new StandImage("mp-pg:local", "pg/Dockerfile", (d) => `${d.configDir}/pg`),
  new StandImage(
    "mp-dt:local",
    "Dockerfile.mp-data-transfer",
    (d) => d.rootDir,
  ),
];

/** Образ web-стека: нужен, только когда есть каталог local-stack. */
export const WEB_IMAGE = new StandImage(
  "sl-front-dev:local",
  "Dockerfile.front",
  (d) => `${d.rootDir}/sl-front`,
  ["--target", "dev"],
);

/** Образы из `images`, которых нет в локальном сторе; inspect — проба. */
export async function missingImages(
  docker: Docker,
  cwd: string,
  images: readonly StandImage[],
): Promise<readonly StandImage[]> {
  const missing: StandImage[] = [];
  for (const image of images) {
    const probe = await docker.probe(
      ["docker", "image", "inspect", image.tag],
      cwd,
    );
    if (probe.code !== 0) missing.push(image);
  }
  return missing;
}
