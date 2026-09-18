/**
 * Исполнение строк по одной (`platform/back-rpc.md`, «Исполнение»):
 * исполнение меняет каталог процесса, поэтому следующая строка начинает
 * исполняться только после кадра `exit` предыдущей — место в очереди
 * держит строка и отпускает его сама.
 */

/** Место в очереди: занято до `leave`. */
export interface Slot {
  leave(): void;
}

/** Места нет: отпускать нечего. */
export const NO_SLOT: Slot = { leave() {} };

/** Очередь исполнения. */
export class Serial {
  #tail: Promise<void> = Promise.resolve();

  /** Место после всех, кто встал раньше. */
  enter(): Promise<Slot> {
    const left = Promise.withResolvers<void>();
    const turn = this.#tail.then(() => ({ leave: () => left.resolve() }));
    this.#tail = left.promise;
    return turn;
  }
}
