/**
 * Окно подтверждения изменения правила (`specs/web.md`): текст вопроса
 * сервера, «Да» / «Нет»; фокус внутри окна, `Esc` — «Нет».
 */

import { useLayoutEffect, useRef } from "react";

export interface ConfirmProps {
  readonly question: string;
  readonly onAnswer: (yes: boolean) => void;
}

export function Confirm({ question, onAnswer }: ConfirmProps) {
  const no = useRef<HTMLButtonElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  // До отрисовки: окна без фокуса внутри не бывает ни на миг.
  useLayoutEffect(() => {
    no.current?.focus();
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onAnswer(false);
      return;
    }
    if (event.key !== "Tab") return;
    // Фокус не уходит из окна: две кнопки по кругу.
    event.preventDefault();
    const next = document.activeElement === no.current ? yes : no;
    next.current?.focus();
  };
  return (
    <div className="backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-question"
        className="dialog"
        onKeyDown={onKeyDown}
      >
        <p id="confirm-question">{question}</p>
        <div className="dialog-actions">
          <button type="button" ref={yes} onClick={() => onAnswer(true)}>
            Да
          </button>
          <button type="button" ref={no} onClick={() => onAnswer(false)}>
            Нет
          </button>
        </div>
      </div>
    </div>
  );
}
