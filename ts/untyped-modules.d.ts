/**
 * Пакеты npm без своих типов. Поверхность, которой пользуется код,
 * объявляет потребитель у себя (`back/src/sql/pg.ts`,
 * `back/src/backend/loopback.ts`, `back/src/invokelog/file.ts`) и
 * приводит к ней импорт; здесь — только то, что такие модули есть.
 */

declare module "pg";
declare module "ws";
declare module "proper-lockfile";
