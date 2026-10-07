/**
 * Корень рабочей области `mp` (`docs/specs/mp-clone.md`, «Корень и
 * права», «Что клонируется», «Предусловия»): список субрепо и два
 * файла корня, которые команда пишет сама, — `.gitignore` и сентинел.
 */

import { z } from "zod";
import { UsageError } from "../command/mod.ts";
import type { Disk } from "./ports.ts";

/**
 * Служебные субрепо: без них не поднимается стенд и не работает
 * тулинг, даже если в workspace их нет.
 */
export const SERVICE_REPOS: readonly string[] = [
  "mp-config-local",
  "ai-tools",
  "opiu-service",
];

/** Заголовок блока субрепо в `.gitignore` корня. */
const DETECTED = "# Detected subrepos:";

const workspaceSchema = z.object({
  folders: z.array(z.object({ path: z.string() })),
});

/** Корень `mp`: откуда берётся список и куда пишутся два файла. */
export class Workspace {
  private constructor(
    readonly root: string,
    private readonly disk: Disk,
    private readonly folders: readonly string[],
  ) {}

  /** Корень от `HOME`; нет `mp.code-workspace` — ошибка ввода (exit 2). */
  static open(home: string, disk: Disk): Workspace {
    const root = `${home}/mr/mp`;
    const file = `${root}/mp.code-workspace`;
    if (!disk.exists(file)) throw new UsageError(`нет ${file}`);
    const parsed = workspaceSchema.safeParse(parseJson(disk.readText(file)));
    if (!parsed.success) {
      throw new UsageError(`${file}: нет списка folders[].path`);
    }
    const folders = parsed.data.folders.map((folder) => folder.path);
    return new Workspace(root, disk, folders);
  }

  /** Субрепо: workspace без `.`, затем служебные — без повторов. */
  names(): readonly string[] {
    const listed = this.folders.filter((path) => path !== ".");
    return [...new Set([...listed, ...SERVICE_REPOS])];
  }

  /** Каталог субрепо. */
  dirOf(name: string): string {
    return `${this.root}/${name}`;
  }

  /** Субрепо, которых нет строкой `/<имя>/` в `.gitignore` корня. */
  unignored(names: readonly string[]): readonly string[] {
    const lines = new Set(this.ignoreLines());
    return names.filter((name) => !lines.has(ignoreLine(name)));
  }

  /** Дописать строки субрепо в блок «Detected subrepos». */
  ignore(names: readonly string[]): void {
    if (names.length === 0) return;
    const lines = this.ignoreLines();
    const added = names.map(ignoreLine);
    const header = lines.indexOf(DETECTED);
    if (header === -1) {
      const tail = lines.length === 0 ? [] : [...lines, ""];
      this.writeIgnore([...tail, DETECTED, ...added]);
      return;
    }
    let end = header + 1;
    while (end < lines.length && lines[end].startsWith("/")) end++;
    this.writeIgnore([...lines.slice(0, end), ...added, ...lines.slice(end)]);
  }

  /** Сентинел корня: создать пустым, если его нет. */
  markRoot(): void {
    const sentinel = `${this.root}/.mp-workspace-root`;
    if (!this.disk.exists(sentinel)) this.disk.writeText(sentinel, "");
  }

  /** Строки `.gitignore` без хвостовой пустой; нет файла — ни одной. */
  private ignoreLines(): string[] {
    const file = `${this.root}/.gitignore`;
    if (!this.disk.exists(file)) return [];
    const lines = this.disk.readText(file).split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  private writeIgnore(lines: readonly string[]): void {
    this.disk.writeText(`${this.root}/.gitignore`, lines.join("\n") + "\n");
  }
}

function ignoreLine(name: string): string {
  return `/${name}/`;
}

/** Разбор JSON; мусор — та же ошибка ввода, что и нет списка. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}
