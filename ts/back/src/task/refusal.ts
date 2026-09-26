/** Отказы канала `mpu task`: классы, которые `glue.ts` переводит в контракт. */

/** Отказ ввода канала: код 2, текст — после префикса команды. */
export class TaskUsage extends Error {
  override name = "TaskUsage";
}

/** Отказ состояния канала: код 1. */
export class TaskRefusal extends Error {
  override name = "TaskRefusal";
}
