/**
 * Первое сообщение роли (`task-orchestrator.md`, «Первое сообщение»): файл
 * `<каталог>/<проект>/<роль>.md` из пяти разделов и строка, которой роль
 * получает его, — при запуске и после `/clear` одна и та же.
 */

import type { ProfileRecord } from "../roles.ts";

/** Строка упавшей роли: работа была начата, контекст потерян. */
export const RESUME_LINE =
  "продолжай с первого незакрытого раздела, сверяясь с git log и git status";

/** Что входит в первое сообщение. */
export interface LetterParts {
  readonly project: string;
  readonly role: string;
  readonly profile: ProfileRecord;
  /** Строки раздела «Что делать сейчас». */
  readonly now: readonly string[];
  /** Кого роль спрашивает: строка раздела «Канал». */
  readonly ask: string;
  /** Вывод `mpu task decisions project: <п>`. */
  readonly decisions: string;
}

/** Файл первого сообщения роли. */
export class Letter {
  readonly path: string;
  readonly text: string;

  /**
   * @param dir каталог файлов первых сообщений (`…/mpu-task`)
   */
  constructor(dir: string, parts: LetterParts) {
    this.path = `${dir}/${parts.project}/${parts.role}.md`;
    this.text = textOf(parts);
  }

  /** Строка, которую роль получает в окне: читать файл и выполнять. */
  message(): string {
    return `Прочитай файл ${this.path} целиком и выполняй его.`;
  }
}

function textOf(parts: LetterParts): string {
  const { project, role, profile } = parts;
  const reads =
    profile.read.length === 0
      ? "нет\n"
      : profile.read.map((path) => `- ${path}\n`).join("");
  return `# Роль: ${role} проекта ${project}

${profile.powers}

## Канал

Команды канала — mpu task … project: ${project}.
Сразу после начала работы — mpu task busy project: ${project} role: ${role}, по окончании — mpu task idle project: ${project} role: ${role}.
${parts.ask}

## Что делать сейчас

${parts.now.map((line) => `${line}\n`).join("")}
## Прочитать первым

${reads}
## Правила и решения

${parts.decisions}`;
}
