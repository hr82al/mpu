/**
 * Core-образы стенда: недостающий собирается той же командой, что
 * build-алиас mp-config-local (`mp-init.md`, «Подъём с нуля», шаг 3).
 *
 * Ключ идемпотентности — наличие тега: есть тег — сборки нет, без
 * сравнения с исходниками (пересборку по зависимостям делает владелец).
 */

import type { Docker } from "./docker.ts";
import type { Step } from "./plan.ts";

/** Образ, который команда умеет собрать сама. */
export class CoreImage {
  /**
   * @param tag тег образа
   * @param dockerfile путь Dockerfile от каталога mp-config-local
   * @param context каталог контекста сборки: от корня `mp` либо от
   *   mp-config-local
   */
  constructor(
    readonly tag: string,
    private readonly dockerfile: string,
    private readonly context: (dirs: StandDirs) => string,
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

/** Три core-образа в порядке проверки; `sl-front-dev` — до M3 не здесь. */
export const CORE_IMAGES: readonly CoreImage[] = [
  new CoreImage("mp-back:local", "Dockerfile.mp-back", (d) => d.rootDir),
  new CoreImage("mp-pg:local", "pg/Dockerfile", (d) => `${d.configDir}/pg`),
  new CoreImage(
    "mp-dt:local",
    "Dockerfile.mp-data-transfer",
    (d) => d.rootDir,
  ),
];

/** Core-образы, которых нет в локальном сторе; inspect — проба. */
export async function missingImages(
  docker: Docker,
  cwd: string,
): Promise<readonly CoreImage[]> {
  const missing: CoreImage[] = [];
  for (const image of CORE_IMAGES) {
    const probe = await docker.probe(
      ["docker", "image", "inspect", image.tag],
      cwd,
    );
    if (probe.code !== 0) missing.push(image);
  }
  return missing;
}
