# CONCATENATE(…) — string concat of all args (and array elements).

(defn- concat-walk [v buf]
  (cond
    (nil? v) nil
    (indexed? v) (each e v (concat-walk e buf))
    (buffer/push-string buf (string v))))

(formula-eval/register "CONCATENATE"
  (fn [args ctx]
    (def b @"")
    (each a args (concat-walk (formula-eval/eval a ctx) b))
    (string b)))
