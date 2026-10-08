/**
 * Что у роли проекта своё (`task-orchestrator.md`, «Шаг проекта»,
 * «Первое сообщение»): какой ход журнала её будит и кого она спрашивает.
 * Имя роли — данные границы (`host|exec`); разбирается один раз здесь, а
 * дальше актёр спрашивает свою часть.
 */

import type { Course, Move } from "./course.ts";

/** Часть роли: её ход и строка «кого спрашивать» первого сообщения. */
export interface Part {
  readonly name: string;
  move(course: Course): Move;
  ask(project: string): string;
}

/** Хост: принимает отчёты, отвечает на вопросы, спрашивает владельца. */
const HOST: Part = {
  name: "host",
  move: (course) => course.host(),
  ask: (project) => `Вопрос владельцу — mpu task owner project: ${project}.`,
};

/** Исполнитель: выполняет постановку, спрашивает хоста. */
const EXEC: Part = {
  name: "exec",
  move: (course) => course.exec(),
  ask: (project) => `Вопрос хосту — mpu task question project: ${project}.`,
};

/** Часть по имени роли из профиля; имена профилей — `host`, `exec`. */
export function partOf(role: string): Part {
  return role === HOST.name ? HOST : EXEC;
}
