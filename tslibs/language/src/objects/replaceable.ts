/** Загружает функцию метода из модуля по адресу. */
export type Loader<S, T> = (url: URL) => Promise<(self: S) => T>;

/**
 * Реализация метода, живущая в модуле: новая версия, загруженная в тот же
 * процесс, отвечает уже на следующее сообщение. Остальные объекты при
 * этом не пересоздаются — меняется только функция внутри.
 */
export class Replaceable<S, T> {
  readonly #load: Loader<S, T>;
  #run: (self: S) => T;

  private constructor(load: Loader<S, T>, run: (self: S) => T) {
    this.#load = load;
    this.#run = run;
  }

  /** Реализация, загруженная по `url`. */
  static async load<S, T>(
    load: Loader<S, T>,
    url: URL,
  ): Promise<Replaceable<S, T>> {
    return new Replaceable(load, await load(url));
  }

  /** Заменяет функцию версией из `url`. */
  async use(url: URL) {
    this.#run = await this.#load(url);
  }

  run(self: S): T {
    return this.#run(self);
  }
}
