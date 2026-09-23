/**
 * Метод образа (`platform/image.md`): получатель, имя, исходник и кто с
 * когда его определил. Отвечает сам — как его зовут, как его ищет вид,
 * что о нём говорит справка и снимок.
 */

import { createHash } from "node:crypto";
import { type MethodSource, nameParts } from "../program/mod.ts";

/** Поля метода, как их пишет и читает файл образа. */
export interface MethodRecord {
  /** Путь получателя — команда или группа дерева. */
  readonly receiver: readonly string[];
  /** Имя: `cardsIn:`, `cardsIn:since:`, унарное `mine`. */
  readonly name: string;
  /** Исходник — слова блока определения `do … done`. */
  readonly words: readonly string[];
  readonly purpose: string;
  /** Описание ключей для справки; нет — пусто. */
  readonly keys: string;
  /** Канал автора: `human`, `agent`, `web`. */
  readonly author: string;
  /** Время определения, ISO UTC. */
  readonly time: string;
}

/** Метод в снимке дерева (`platform/reflection.md`). */
export interface MethodSnapshot {
  readonly author: string;
  readonly time: string;
  readonly source: string;
}

/** Метка метода образа в назначении (`messages`, справка). */
const LABEL = "образ";

/** Метод образа. */
export class ImageMethod {
  readonly #record: MethodRecord;

  constructor(record: MethodRecord) {
    this.#record = {
      ...record,
      receiver: [...record.receiver],
      words: [...record.words],
    };
  }

  /** Поля метода копией — файлу образа. */
  record(): MethodRecord {
    return { ...this.#record };
  }

  /** Исходник текстом: слова через один пробел. */
  text(): string {
    return this.#record.words.join(" ");
  }

  /** sha256 исходника текстом, hex. */
  hash(): string {
    return createHash("sha256").update(this.text()).digest("hex");
  }

  /** Части имени ключами (`cardsIn:`, `since:`); у унарного — нет. */
  parts(): string[] {
    return nameParts(this.#record.name);
  }

  /**
   * Селектор, которым метод ищет вид: унарное — имя, ключевое — части по
   * алфавиту, как у любого ключевого сообщения строки.
   */
  selector(): string {
    const parts = this.parts();
    if (parts.length === 0) return this.#record.name;
    return [...parts].sort().join("");
  }

  /**
   * Тот ли это метод, что назван в строке: получатель тот же, имя — как
   * есть или без последнего двоеточия (`cardsIn` ≡ `cardsIn:`).
   */
  named(receiver: readonly string[], written: string): boolean {
    const { name } = this.#record;
    return this.#record.receiver.join(" ") === receiver.join(" ") &&
      (name === written || name === `${written}:`);
  }

  /** Звенья пути правила метода: получатель и имя по порядку. */
  links(): string[] {
    return [...this.#record.receiver, this.#record.name];
  }

  /** Назначение с меткой образа. */
  purposeLine(): string {
    return `${LABEL}: ${this.#record.purpose}`;
  }

  /** Текст справки: кто и когда определил, исходник; ключи — у вида. */
  help(): string {
    const { author, time } = this.#record;
    return `Метод образа, определён ${author} ${time}.\n` +
      `Исходник: ${this.text()}`;
  }

  /** Поле `image` узла метода в снимке дерева. */
  snapshot(): MethodSnapshot {
    const { author, time } = this.#record;
    return { author, time, source: this.text() };
  }

  /** Метод глазами программы: где, как зовётся, из чего. */
  source(): MethodSource {
    const { receiver, name, words } = this.#record;
    return { receiver: [...receiver], name, source: [...words] };
  }
}
