/**
 * Панель метода образа под его узлом (`web-image.md`, «Экран «Правила» —
 * дополнение»): кто и когда определил, исходник, поле правки ровно с
 * `image.definition`, «Сохранить» и «Удалить метод». Слова поля — деление
 * по правилу «Текст → слова» из контракта `back`; определение фронт не
 * разбирает.
 */

import { useState } from "react";
import { wordsOf } from "../../back/src/frames/mod.ts";
import type { MethodImage } from "./api.ts";
import { Confirm } from "./Confirm.tsx";
import { told, useLine } from "./useLine.ts";

export interface MethodPanelProps {
  /** Путь узла метода: получатель и имя (`kiten`, `cardsIn:`). */
  readonly path: readonly string[];
  readonly image: MethodImage;
  /** Итог строки — перечитать дерево. */
  readonly changed: () => void;
}

/** Кто и когда определил метод, его исходник. */
function MethodFacts({ image }: { image: MethodImage }) {
  return (
    <dl>
      <dt>автор</dt>
      <dd>{image.author}</dd>
      <dt>время</dt>
      <dd>{image.time}</dd>
      <dt>исходник</dt>
      <dd>
        <code>{image.source}</code>
      </dd>
    </dl>
  );
}

export function MethodPanel({ path, image, changed }: MethodPanelProps) {
  const [text, setText] = useState(image.definition);
  const line = useLine(changed);
  const said = told(line.last);
  return (
    <div className="method">
      <MethodFacts image={image} />
      <label>
        Определение {path.join(" ")}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => line.send(["ask", ...wordsOf(text)])}
      >
        Сохранить
      </button>
      <button
        type="button"
        onClick={() =>
          line.send([
            "ask",
            ...path.slice(0, -1),
            "forget:",
            ...path.slice(-1),
          ])}
      >
        Удалить метод
      </button>
      {said !== "" && <p className="said">{said}</p>}
      {line.pending !== undefined && (
        <Confirm
          question={line.pending.question}
          onAnswer={(yes) => line.respond(yes)}
        />
      )}
    </div>
  );
}
