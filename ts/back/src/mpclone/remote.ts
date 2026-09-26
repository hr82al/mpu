/**
 * Сервер GitLab глазами команды (`docs/specs/mp-clone.md`, «Предусловия»,
 * «Граничные случаи»): ключ хоста в `known_hosts` и есть ли на сервере
 * репозиторий.
 *
 * Ключ проверяется при первом обращении к серверу, а не на старте:
 * области, где всё уже склонировано, сервер не нужен вовсе.
 */

import type { Shell } from "./ports.ts";

const HOST = "gitlab.btlz-api.ru";
const PORT = "2222";

/**
 * Ответ GitLab по ssh на несуществующий проект: «The project you were
 * looking for could not be found or you don't have permission to view
 * it.» — догадка по известной форме отказа GitLab, живьём не снята
 * (из этой сессии сервер недостижим). Всё прочее — не «нет
 * репозитория», а ошибка сети или ключа.
 */
const NOT_FOUND = /could not be found/;

/** Остановка команды: текст для строки `mpu mp-clone: …` и код выхода. */
export class CloneStop extends Error {
  override readonly name = "CloneStop";

  constructor(
    message: string,
    readonly exitCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Адрес субрепо: только ssh — https без кред не отвечает. */
export function urlOf(name: string): string {
  return `ssh://git@${HOST}:${PORT}/wb/${name}.git`;
}

/** Первая непустая строка вывода — текст отказа внешней программы. */
export function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) =>
    line !== ""
  ) ?? "";
}

/** Сервер: ключ хоста проверяется один раз, до первого `ls-remote`. */
export class Remote {
  private keyChecked = false;

  constructor(private readonly shell: Shell) {}

  /** Есть ли репозиторий; ошибка сети или ключа — остановка exit 1. */
  async has(name: string): Promise<boolean> {
    await this.checkKey();
    const probe = await this.shell.run([
      "git",
      "ls-remote",
      urlOf(name),
      "HEAD",
    ]);
    if (probe.code === 0) return true;
    if (NOT_FOUND.test(probe.stderr)) return false;
    throw new CloneStop(
      `${name} — git ls-remote: ${firstLine(probe.stderr)}`,
      1,
    );
  }

  /** Нет ключа — остановка exit 3 с отпечатком и строкой для человека. */
  private async checkKey(): Promise<void> {
    if (this.keyChecked) return;
    const known = await this.shell.run([
      "ssh-keygen",
      "-F",
      `[${HOST}]:${PORT}`,
    ]);
    if (known.code === 0) {
      this.keyChecked = true;
      return;
    }
    throw new CloneStop(
      `ключа ${HOST}:${PORT} нет в known_hosts — отпечаток ${await this
        .fingerprint()}; принять: ssh-keyscan -p ${PORT} ${HOST} >> ~/.ssh/known_hosts`,
      3,
    );
  }

  /** Отпечатки ключей хоста, снятые `ssh-keyscan`, — только печать. */
  private async fingerprint(): Promise<string> {
    const scan = await this.shell.run(["ssh-keyscan", "-p", PORT, HOST]);
    if (scan.code !== 0 || scan.stdout.trim() === "") {
      return `не снят (${firstLine(scan.stderr)})`;
    }
    const listed = await this.shell.run(
      ["ssh-keygen", "-lf", "-"],
      scan.stdout,
    );
    const prints = listed.stdout.split("\n")
      .map((line) => line.split(" ")[1] ?? "")
      .filter((print) => print.startsWith("SHA256:"));
    return prints.length === 0
      ? `не снят (${firstLine(listed.stderr)})`
      : prints.join(", ");
  }
}
