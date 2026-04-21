# ss-analyze — trace the dependency chain that produces a cell's value.
# Usage: mpu ss-analyze -s <id> -n <sheet> -a <cell>
#
# 1. Finds the formula cell that fills the target (find-source).
# 2. Parses the formula and extracts every ref / range.
# 3. Recursively repeats: for each referenced cell, resolve it again —
#    stops at direct values, empty cells, external sheets, or cycles.
# All flags except -a/--address are forwarded verbatim to mpu batch-get-all,
# so smart defaults (-s, -n) and forceCache keep working through the Go bridge.

(var- target nil)
(def- forwarded @[])

(var- i 0)
(def- argc (length *args*))
(while (< i argc)
  (def a (get *args* i))
  (cond
    (or (= a "-a") (= a "--address"))
    (do
      (set target (get *args* (+ i 1)))
      (+= i 2))
    (do (array/push forwarded a) (++ i))))

(unless target
  (error "ss-analyze: -a/--address is required (target cell, e.g. T6)"))

(def raw (mpu/batch-get-all ;forwarded))
(when (or (nil? raw) (empty? raw))
  (error "ss-analyze: mpu/batch-get-all returned no data"))

(def merged (json/decode raw))

# ── rendering ──────────────────────────────────────────────────

(defn- fmt-value [v]
  (cond
    (nil? v) "(nil)"
    (string? v) (string/format "%q" v)
    (string/format "%j" v)))

(defn- render-node [node depth]
  (def pad (string/repeat "  " depth))
  (def kind (get node :kind))
  (def addr (get node :addr))
  (case kind
    :direct
    (printf "%s%s = %s" pad addr (fmt-value (get node :value)))

    :empty
    (printf "%s%s  (empty)" pad addr)

    :external
    (printf "%s%s  (external sheet)" pad addr)

    :range-ref
    (let [cells (get node :cells @[])
          row   (get node :row)]
      (if (empty? cells)
        (printf "%s[%s]  (lookup range)" pad addr)
        (do
          (printf "%s[%s]  (lookup range, row %d)" pad addr row)
          (each c cells (render-node c (+ depth 1))))))

    :cycle
    (printf "%s%s ↺ cycle → %s" pad addr (get node :src))

    :depth-limit
    (printf "%s%s  (…)" pad addr)

    :formula
    (do
      (def src (get node :src))
      (def label (if (= src addr) addr (string addr " ← " src)))
      (printf "%s%s := %s" pad label (get node :formula))
      (when-let [pe (get node :parse-error)]
        (printf "%s  ! parse-error: %s" pad pe))
      (each child (get node :children @[]) (render-node child (+ depth 1))))

    (printf "%s%s  (unknown kind %j)" pad addr kind)))

# ── output ──────────────────────────────────────────────────────

(def src (formula-finder/find-source merged target))
(if src
  (let [[addr formula] src]
    (printf "# %s → %s" target addr)
    (printf "# raw: %s" formula)
    (def ast (try (formula-parser/parse formula)
               ([e]
                 (errorf "formula-parser failed on %s: %s\n  formula: %s"
                         addr e formula))))
    (printf "# ast: %j" ast)
    (printf ""))
  (printf "# %s has no source formula — tracing direct value" target))

# Derive the analysis row from the target address so same-sheet lookup
# ranges can surface the concrete cells intersecting that row.
(def target-rc (protect (formula-finder/cell->rc target)))
(def analysis-row (if (get target-rc 0) (get (get target-rc 1) 0)))

(def tree (formula-deps/trace merged target @{} analysis-row))
(render-node tree 0)
