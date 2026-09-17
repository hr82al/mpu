/**
 * Объект отказывает ответить. Текст — без пути: путь до приёмника знает
 * только исполнитель цепочки, он и допишет его спереди.
 */
export class Refusal extends Error {
  override name = "Refusal";
}

/** Строка не исполнилась: итоговый текст отказа для вызывающего. */
export class Rejection extends Error {
  override name = "Rejection";
}
