# ss-eval — evaluate every formula in a Google Sheet and report matches.
#
#   mpu ss-eval -s <spreadsheet-id> -n <sheet> [-a <cell>]
#
# Finds each formula's source via formula-finder/resolve, parses it,
# evaluates via formula-eval/eval, and compares to the recorded cell
# value. Prints a summary and a list of missing functions (stub calls
# that auto-generated files in formula-fns/).

(var- target nil)
(var- spreadsheet-id nil)
(def- forwarded @[])

(var- i 0)
(def- argc (length *args*))
(while (< i argc)
  (def a (get *args* i))
  (cond
    (or (= a "-a") (= a "--address"))
    (do (set target (get *args* (+ i 1))) (+= i 2))

    (or (= a "-s") (= a "--spreadsheet-id"))
    (do
      (set spreadsheet-id (get *args* (+ i 1)))
      (array/push forwarded a)
      (array/push forwarded (get *args* (+ i 1)))
      (+= i 2))

    (do (array/push forwarded a) (++ i))))

(def raw (mpu/batch-get-all ;forwarded))
(when (or (nil? raw) (empty? raw))
  (error "ss-eval: mpu/batch-get-all returned no data"))

(def merged (json/decode raw))

# Stub-dir: auto-create fn templates in janet/formula-fns/.
(def janet-dir (or (os/getenv "MPU_JANET_DIR")
                   (string (os/getenv "HOME") "/.config/mpu/janet")))
(def stub-dir (string janet-dir "/formula-fns"))

(def stats @{:total 0 :match 0 :mismatch 0 :stub 0 :error 0 :direct 0})
(def mismatches @[])
(def eval-errors @[])
(def missing @{})
(def unresolved-list @[])

(defn- process-cell [addr]
  (def r (formula-finder/resolve merged addr))
  (cond
    (nil? r) nil
    (= (get r 0) :direct) (update stats :direct inc)
    (= (get r 0) :formula)
    (let [formula (get r 2) src-addr (get r 1)]
      # only evaluate formulas whose home cell is addr itself (avoid
      # re-evaluating one formula N times for N spilled cells)
      (when (= src-addr addr)
        (update stats :total inc)
        (def ctx @{:merged merged
                   :sheet-name (or (get-in merged [0 "range"]) "")
                   :spreadsheet-id spreadsheet-id
                   :addr addr
                   :sheet-cache @{}
                   :missing-fns @{}
                   :unresolved @[]
                   :stub-dir stub-dir})
        (def parsed (protect (formula-parser/parse formula)))
        (if (get parsed 0)
          (let [ast (get parsed 1)
                er  (protect (formula-eval/eval ast ctx))]
            # propagate per-cell missing/unresolved into the run totals
            (each k (keys (ctx :missing-fns)) (put missing k true))
            (each u (ctx :unresolved) (array/push unresolved-list u))
            (if (get er 0)
              (let [value (get er 1)
                    actual (get (formula-finder/lookup-cell merged addr) "v")]
                (cond
                  (and (indexed? value) (= (get value 0) :stub))
                  (update stats :stub inc)
                  (deep= value actual)
                  (update stats :match inc)
                  (do (update stats :mismatch inc)
                      (array/push mismatches
                                  [addr formula actual value]))))
              (do (update stats :error inc)
                  (array/push eval-errors [addr formula (get er 1)]))))
          (do (update stats :error inc)
              (array/push eval-errors [addr formula (get parsed 1)])))))))

# When -a is given, evaluate just that cell (verbose). Otherwise sweep.
(if target
  (do
    (printf "# target: %s" target)
    (process-cell target)
    (printf "stats: %j" stats))
  (do
    (def seen @{})
    (each rng merged
      (each row (get rng "values")
        (each cell row
          (def a (get cell "a"))
          (unless (get seen a)
            (put seen a true)
            (process-cell a)))))
    (printf "# ss-eval report")
    (printf "total formulas:  %d" (stats :total))
    (printf "  matched:       %d" (stats :match))
    (printf "  stub-returned: %d  (missing-fn implementations)" (stats :stub))
    (printf "  mismatched:    %d" (stats :mismatch))
    (printf "  eval errors:   %d" (stats :error))
    (printf "direct values:   %d" (stats :direct))
    (printf "")
    (printf "# missing functions — stubs auto-written to %s" stub-dir)
    (each k (sorted (keys missing)) (printf "  %s" k))
    (printf "")
    (printf "# unresolved (named ranges / items to implement manually)")
    (def uniq @{})
    (each u unresolved-list (put uniq (get u 1) true))
    (each k (sorted (keys uniq)) (printf "  [:name %s]" k))
    (when (pos? (length mismatches))
      (printf "")
      (printf "# first 5 mismatches")
      (each m (array/slice mismatches 0 (min 5 (length mismatches)))
        (printf "  %j" m)))
    (when (pos? (length eval-errors))
      (printf "")
      (printf "# first 5 eval errors")
      (each e (array/slice eval-errors 0 (min 5 (length eval-errors)))
        (printf "  %j" e)))))
