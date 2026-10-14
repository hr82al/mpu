/**
 * Учёт литералов данных одного файла (`specs/code-literals.md`, «Что
 * считается»): какие значения повторены и какая величина записана в двух
 * формах.
 *
 * Оба раздела ответа выводятся из одного — из групп равных значений:
 * повтор — группа с двумя вхождениями и больше, пара — две группы, одна
 * из которых называет другую своей второй формой. Поэтому и счёт, и
 * строки держит группа, а не тот, кто печатает.
 */

/** Повтор: значение, сколько раз оно встретилось и в каких строках. */
export interface Repeat {
  readonly value: string;
  readonly count: number;
  readonly lines: number[];
}

/** Пара двух форм одной величины и строки вхождений обеих. */
export interface Pair {
  readonly first: string;
  readonly second: string;
  readonly lines: number[];
}

/**
 * Значение литерала. Особые случаи пар — в самих значениях: число знает
 * свою строку, дата — свою вторую запись, у прочих второй формы нет.
 */
interface Value {
  /** Ключ равенства: строки — по тексту, числа — по значению. */
  readonly key: string;
  /** Как значение печатается в записи. */
  readonly shown: string;
  /** `''`, `0`, `1`, `-1` в учёт не идут (спека, «Не считается», 5). */
  readonly trivial: boolean;
  /** Та же величина в другой записи — закрытый список пар спеки. */
  secondForms(): readonly Value[];
}

/**
 * Знаки, которые в печати строки экранируются: вывод построчный, и
 * перевод строки внутри значения разорвал бы запись на две.
 */
const ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "'": "\\'",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

class Text implements Value {
  readonly key: string;
  readonly shown: string;
  readonly trivial: boolean;
  constructor(text: string) {
    this.key = `text:${text}`;
    this.shown = `'${text.replace(/[\\'\n\r\t]/g, (sign) => ESCAPES[sign])}'`;
    this.trivial = text === "";
  }
  secondForms(): readonly Value[] {
    return [];
  }
}

class Num implements Value {
  readonly key: string;
  readonly shown: string;
  readonly trivial: boolean;
  constructor(private readonly value: number) {
    // Равенство по значению: `1e3` и `1000` дают одну запись `1000`.
    this.key = `number:${String(value)}`;
    this.shown = String(value);
    this.trivial = value === 0 || value === 1 || value === -1;
  }
  /** Строка, чей текст — десятичная запись того же числа (`101` ↔ `'101'`). */
  secondForms(): readonly Value[] {
    return [new Text(String(this.value))];
  }
}

/** День `ГГГГ-ММ-ДД`; его вторая форма — тот же день `ДД.ММ.ГГГГ`. */
class IsoDay implements Value {
  readonly key: string;
  readonly shown: string;
  readonly trivial = false;
  constructor(
    private readonly year: string,
    private readonly month: string,
    private readonly day: string,
  ) {
    this.key = `iso:${year}-${month}-${day}`;
    this.shown = `'${year}-${month}-${day}'`;
  }
  secondForms(): readonly Value[] {
    return [new DottedDay(this.year, this.month, this.day)];
  }
}

/** День `ДД.ММ.ГГГГ`: вторая форма ISO-дня, своей второй формы нет. */
class DottedDay implements Value {
  readonly key: string;
  readonly shown: string;
  readonly trivial = false;
  constructor(year: string, month: string, day: string) {
    this.key = `dotted:${day}.${month}.${year}`;
    this.shown = `'${day}.${month}.${year}'`;
  }
  secondForms(): readonly Value[] {
    return [];
  }
}

const MONTH = "(0[1-9]|1[0-2])";
const DAY = "(0[1-9]|[12]\\d|3[01])";
const ISO_SOURCE = `(\\d{4})-${MONTH}-${DAY}`;
const DOTTED_SOURCE = `${DAY}\\.${MONTH}\\.(\\d{4})`;

/**
 * Даты обеих записей внутри текста. Цифры по краям запрещены: иначе
 * `12026-09-041` читалось бы датой.
 */
const ISO_DAY = new RegExp(`(?<!\\d)${ISO_SOURCE}(?!\\d)`, "g");
const DOTTED_DAY = new RegExp(`(?<!\\d)${DOTTED_SOURCE}(?!\\d)`, "g");

/** Строка, целиком равная дате одной из записей. */
const WHOLE_DAY = new RegExp(`^(?:${ISO_SOURCE}|${DOTTED_SOURCE})$`);

/** Вхождения дат в тексте строки, в порядке появления. */
function datesIn(text: string): readonly Value[] {
  const found: { readonly at: number; readonly day: Value }[] = [];
  for (const match of text.matchAll(ISO_DAY)) {
    const [, year, month, day] = match;
    found.push({ at: match.index, day: new IsoDay(year, month, day) });
  }
  for (const match of text.matchAll(DOTTED_DAY)) {
    const [, day, month, year] = match;
    found.push({ at: match.index, day: new DottedDay(year, month, day) });
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.day);
}

/** Равные значения файла: сама считает вхождения и строки. */
class Group {
  #count = 0;
  readonly #lines = new Set<number>();

  constructor(readonly value: Value) {}

  add(line: number): void {
    this.#count += 1;
    this.#lines.add(line);
  }

  /** Повтор — два вхождения и больше в одном файле. */
  get repeated(): boolean {
    return this.#count >= 2;
  }

  /** Строки по возрастанию, каждая один раз. */
  lines(): number[] {
    return [...this.#lines].sort((a, b) => a - b);
  }

  repeat(): Repeat {
    return { value: this.value.shown, count: this.#count, lines: this.lines() };
  }
}

/**
 * Учёт литералов одного файла. Принимает вхождения сообщениями-
 * намерениями того места, где литерал стоит, и отдаёт оба раздела.
 */
export class Tally {
  readonly #groups = new Map<string, Group>();

  /**
   * Строка данных: даты внутри неё и она сама. Строка, целиком равная
   * дате, повтором строки отдельно не считается — иначе одна дата
   * печаталась бы двумя записями (спека, «Даты»).
   */
  addString(text: string, line: number): void {
    if (!WHOLE_DAY.test(text)) this.#add(new Text(text), line);
    this.addDatesIn(text, line);
  }

  /** Только даты внутри строки: место — адрес экрана, а не данные. */
  addDatesIn(text: string, line: number): void {
    for (const day of datesIn(text)) this.#add(day, line);
  }

  addNumber(value: number, line: number): void {
    this.#add(new Num(value), line);
  }

  /** Повторы в порядке первой строки вхождения. */
  repeats(): readonly Repeat[] {
    return [...this.#groups.values()]
      .filter((group) => group.repeated)
      .map((group) => group.repeat())
      .sort((a, b) => a.lines[0] - b.lines[0]);
  }

  /**
   * Пары: группа и её вторая форма, если та встретилась в файле. Пара
   * печатается и при одном вхождении каждой формы — повтора она не
   * требует.
   */
  pairs(): readonly Pair[] {
    const found: Pair[] = [];
    for (const group of this.#groups.values()) {
      for (const form of group.value.secondForms()) {
        if (!this.#groups.has(form.key)) continue;
        found.push(pairOf(group, this.#group(form)));
      }
    }
    return found.sort((a, b) => a.lines[0] - b.lines[0]);
  }

  #add(value: Value, line: number): void {
    if (value.trivial) return;
    this.#group(value).add(line);
  }

  /** Группа значения; первой встречи — новая. */
  #group(value: Value): Group {
    const known = this.#groups.get(value.key);
    if (known !== undefined) return known;
    const created = new Group(value);
    this.#groups.set(value.key, created);
    return created;
  }
}

function pairOf(first: Group, second: Group): Pair {
  const lines = new Set([...first.lines(), ...second.lines()]);
  return {
    first: first.value.shown,
    second: second.value.shown,
    lines: [...lines].sort((a, b) => a - b),
  };
}
