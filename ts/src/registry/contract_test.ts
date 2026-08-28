/**
 * Семь инвариантов `platform/command-contract.md`, проверяемых обходом
 * реестра: каждая зарегистрированная команда обязана удовлетворять им,
 * поэтому новая команда попадает под проверку без правки этого файла.
 * Способ проверки для каждого инварианта назван спекой и повторён в
 * названии шага.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { commands, findCommand, findGroup, findLegacy } from "./mod.ts";
import { openCacheDb as openStoreDb } from "../store/mod.ts";
import { type Command, type CommandIo, UsageError } from "../command/mod.ts";

/**
 * Образец вызова команды: аргументы, которые она принимает, и образец
 * её результата. Таблица обязана покрывать реестр целиком — это
 * проверяет отдельный шаг, иначе новая команда молча выпадет из обхода.
 */
interface CommandCase {
  /** Путь команды через пробел, как в реестре. */
  readonly path: string;
  /** Аргументы командной строки без пути команды. */
  readonly argv: readonly string[];
  /** Литеральный результат для проверки рендера и сериализации. */
  readonly sampleResult: unknown;
}

/** Запись учёта времени в форме вывода: общий образец трёх листьев `time`. */
const SAMPLE_TIME_LOG = {
  id: 7000001,
  card_id: 10000001,
  for_date: "2026-08-14",
  minutes: 75,
  role_id: 12058,
  role: "Техподдержка",
  user_id: 900001,
  user: "Иван Тестов",
  comment: "разбор жалобы",
};

/** Результат обёртки семейства в форме вывода: общий образец листьев. */
const SAMPLE_WRAP = {
  server: "sl-9",
  inner: "node cli service:ozonJobs showJobs",
  printed: null,
  output: "",
  exitCode: 0,
};

/** Показ копии таблицы: общий образец трёх команд `backup-*`. */
const SAMPLE_BACKUP = {
  marketplace: "wb",
  source_table: "schema_777.wb_unit_proto",
  date_suffix: "20260827",
  server: "sl-9",
  pg_host: "10.9.9.9",
  pg_port: 5432,
  database: "mp",
  sql: "CREATE TABLE backups.wb_unit_proto_777_20260827 AS\n" +
    "SELECT * FROM schema_777.wb_unit_proto;",
  dry: true,
};

const CASES: readonly CommandCase[] = [
  {
    path: "xlsx ls",
    argv: ["-f", "sample.xlsx"],
    sampleResult: {
      sheets: [{ title: "Данные", index: 0, rows: 6, cols: 3 }],
    },
  },
  {
    path: "xlsx get",
    argv: ["-f", "sample.xlsx", "Данные!A1"],
    sampleResult: {
      file: "/tmp/книга.xlsx",
      cells: [
        { range: "Данные!A1", value: "имя" },
        { range: "Данные!A2", value: 42, formula: "=6*7" },
        { range: "Данные!A3", value: null },
      ],
    },
  },
  {
    path: "xlsx open",
    argv: ["-f", "sample.xlsx", "--print"],
    sampleResult: { path: "/tmp/книга.xlsx", launched: false },
  },
  {
    path: "xlsx resolve",
    argv: ["-f", "sample.xlsx"],
    sampleResult: {
      resolved: { path: "/tmp/книга.xlsx", source: "flag" },
      checked: [
        {
          source: "flag",
          label: "--file/-f",
          value: "sample.xlsx",
          used: true,
        },
        {
          source: "env",
          label: "MPU_XLSX (env-файл)",
          value: null,
          used: false,
        },
        {
          source: "config",
          label: "config xlsx.default",
          value: null,
          used: false,
        },
      ],
    },
  },
  {
    path: "xlsx alias add",
    argv: ["otchet", "/tmp/книга.xlsx"],
    sampleResult: { name: "otchet", path: "/tmp/книга.xlsx", created: true },
  },
  {
    path: "xlsx alias ls",
    argv: [],
    sampleResult: { aliases: [{ name: "otchet", path: "/tmp/книга.xlsx" }] },
  },
  {
    path: "xlsx alias rm",
    argv: ["otchet"],
    sampleResult: { name: "otchet", removed: true },
  },
  {
    path: "mcp token",
    argv: [],
    // Значение синтетическое: настоящий токен в образцы не попадает.
    sampleResult: { headers: { Authorization: "Bearer проба-токена" } },
  },
  {
    path: "init",
    argv: ["--dry-run"],
    sampleResult: {
      portainerUrl: "https://portainer.example.com",
      containers: [{
        serverNumber: 1,
        containerName: "sl-1-cli",
        state: "running",
        endpointId: 1,
        endpointName: "prod",
      }],
      otherCount: 2,
      reset: null,
      write: null,
      loki: { skipped: null, hosts: 4, pairs: 6 },
      kaiten: {
        skipped: null,
        spaces: 2,
        boards: 3,
        lanes: 7,
        columns: null,
        roles: 2,
        skippedBoards: [{
          boardId: 502,
          reason: "kaiten GET /boards/502/columns -> 500: boom",
        }],
      },
      telegram: { skipped: null },
    },
  },
  {
    path: "run-js",
    // Вызов без адресации отказывает на разборе ввода: живого
    // контейнера у обхода нет, исполнять в нём произвольный JS он не
    // должен тем более, а `--dry-run` писал бы в буфер обмена машины,
    // на которой идут тесты.
    argv: [],
    sampleResult: {
      mode: "dry-run",
      targets: [{ label: "sl-1", exitCode: null, failure: null }],
      detach: null,
      preview: "mpu ssh sl-1 -- node --input-type=module -" +
        " <<'__MPU_RUN_JS_EOF__'\nconsole.log(1)\n__MPU_RUN_JS_EOF__\n",
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "jsdate",
    // Вход пуст по контракту; результат зависит только от часов машины,
    // поэтому образец — синтетическая метка нужной формы.
    argv: [],
    sampleResult: { stamp: "20260818153456" },
  },
  {
    path: "ssh",
    // Пустая команда — единственный вход, который отказывает раньше
    // всякого транспорта (`specs/ssh.md`, «Граничные случаи»): живого
    // контейнера у обхода нет, а исполнять в нём что-либо он не должен
    // тем более.
    argv: [],
    sampleResult: { exitCode: 0, output: "" },
  },
  {
    path: "sql",
    // `--dry` не открывает соединений — единственный режим, безопасный
    // по построению (`specs/sql.md`, «Инварианты»): живой БД у обхода
    // нет, а мутировать чужую он тем более не должен.
    argv: ["sl-1", "UPDATE t SET a = 1 WHERE 1=0", "--dry"],
    sampleResult: {
      server: "sl-1",
      host: "10.0.0.1",
      port: 5432,
      database: "wb",
      searchPath: null,
      sql: "UPDATE t SET a = 1 WHERE 1=0",
      dry: true,
      outcome: null,
    },
  },
  {
    path: "sql-ro",
    // `--dry` не открывает соединений: живого PostgreSQL у обхода нет,
    // а вызов обязан молчать и в отказе (см. инвариант 1).
    argv: ["sl-1", "SELECT 1", "--dry"],
    sampleResult: {
      server: "sl-1",
      host: "10.0.0.1",
      port: 5432,
      database: "wb",
      searchPath: "schema_42",
      sql: "SELECT 1 AS one",
      dry: false,
      outcome: { kind: "rows", columns: ["one"], rows: [[1]] },
    },
  },
  {
    path: "health",
    // Невалидный `--since` отказывает до сети и до кэша (спека,
    // отклонение `fix`): живой фермы у обхода нет, а вытягивать боевые
    // логи он не должен тем более.
    argv: ["sl-1", "--since", "вчера"],
    sampleResult: {
      server: "sl-1",
      rows: [{ name: "mp-sl-1-cli", state: "running", status: "Up 3 days" }],
      mpCount: 1,
      oneShot: [],
      notRunning: [],
      tails: [{ name: "mp-wb-loader-app", text: "ошибка\n", error: null }],
      tail: 30,
      exitCode: 0,
    },
  },
  {
    path: "ss-update",
    // `--print` ничего не выполняет и в сеть не ходит: у обхода нет ни
    // живого контейнера, ни права его трогать — дефолтный режим этой
    // команды мутирует прод клиента.
    argv: ["777", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:ssUpdater update --client-id 777" +
        " --spreadsheet-id SHEET123 --update-type schedule --logs info",
      printed: 'sl-9-cli sh -c "node cli service:ssUpdater update"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader reports",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader cards",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader adv-auto-keywords-stats",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader adv-fullstats",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader search-texts",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader analytics-by-period",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader adverts",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-loader search-clusters-bids",
    argv: ["777", "--sid", "SID42", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbLoader wb --client-id 777 --sid SID42",
      printed: 'sl-9-cli sh -c "node cli service:wbLoader wb"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "data-loader",
    // `--print` ничего не выполняет и в сеть не ходит: дефолтный режим
    // этой команды — серверная операция в проде клиента.
    argv: ["777", "--sids", "abc", "--sids", "def", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:dataLoader findCandidate --client-id 777" +
        " --sids abc def",
      printed: 'sl-9-cli sh -c "node cli service:dataLoader findCandidate"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-recalculate-expenses",
    argv: ["777", "--date-from", "2026-01-01", "--date-to", "2026-01-31", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbUnitCalculatedData recalculateExpenses" +
        " --client-id 777 --date-from 2026-01-01 --date-to 2026-01-31",
      printed: 'sl-9-cli sh -c "node cli service:wbUnitCalculatedData"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "wb-save-expenses",
    argv: ["777", "--date-from", "2026-01-01", "--date-to", "2026-01-31", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:wbUnitCalculatedData saveExpenses" +
        " --client-id 777 --date-from 2026-01-01 --date-to 2026-01-31",
      printed: 'sl-9-cli sh -c "node cli service:wbUnitCalculatedData"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "ozon-recalculate-expenses",
    argv: ["777", "--date-from", "2026-01-01", "--date-to", "2026-01-31", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:ozonUnitCalculatedData recalculateExpenses" +
        " --client-id 777 --date-from 2026-01-01 --date-to 2026-01-31",
      printed: 'sl-9-cli sh -c "node cli service:ozonUnitCalculatedData"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "ozon-save-expenses",
    argv: ["777", "--date-from", "2026-01-01", "--date-to", "2026-01-31", "-p"],
    sampleResult: {
      server: "sl-9",
      inner: "node cli service:ozonUnitCalculatedData saveExpenses" +
        " --client-id 777 --date-from 2026-01-01 --date-to 2026-01-31",
      printed: 'sl-9-cli sh -c "node cli service:ozonUnitCalculatedData"',
      output: "",
      exitCode: 0,
    },
  },
  {
    path: "search",
    // Локальный режим и `--no-update`: обход не ходит в сеть и не
    // трогает 10X — impersonate пишет прод-аудит, а автосинку нужен PG.
    argv: ["777", "--no-update"],
    sampleResult: {
      rows: [{
        client_id: 777,
        spreadsheet_id: "SHEET123",
        title: "Таблица клиента",
        server: "sl-9",
        server_number: 9,
        sl_ip: "10.9.9.9",
        pg_ip: "10.9.9.10",
        sids: [],
      }],
      projection: null,
      synced: false,
      target: null,
      ambiguous: null,
    },
  },
  {
    path: "log",
    // Журнала в окружении обхода нет: команда обязана ответить пустым
    // результатом и промолчать в потоки (инвариант 1).
    argv: ["--file", "/нет/такого/журнала.log"],
    sampleResult: { records: [] },
  },
  {
    path: "ps",
    // Без селектора — снапшот локального кэша: сети у обхода нет, а
    // пустая кэш-БД временного каталога даёт отказ — молча, как
    // требует инвариант 1.
    argv: [],
    sampleResult: {
      source: "cache",
      containers: [{
        endpoint: "sl-1",
        name: "mp-sl-1-cli",
        state: "running",
        status: null,
        image: "registry.example/app:1.2.3",
      }],
    },
  },
  {
    path: "logs",
    // `ls` читает только локальный кэш: сети у обхода нет, а пустая
    // кэш-БД временного каталога даёт отказ — молча, как требует
    // инвариант 1.
    argv: ["ls"],
    sampleResult: {
      kind: "entries",
      names: [],
      entries: [{ tsNs: "1754380800000000000", line: "строка сервиса" }],
      snapshot: null,
    },
  },
  {
    path: "update",
    argv: [],
    sampleResult: {
      clients: 12,
      spreadsheets: 340,
      servers: 4,
      wbSids: 58,
      tookSeconds: 1.23,
      failedServers: [{ server: "sl-2", reason: "нет соединения за 5000ms" }],
      loki: { skipped: null, hosts: 3, pairs: 9 },
    },
  },
  {
    path: "kiten whoami",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // до сети и молча, как требует инвариант 1.
    argv: [],
    sampleResult: {
      user: {
        id: 900001,
        full_name: "Иван Тестов",
        username: "ivanov",
        email: "ivanov@example.test",
      },
    },
  },
  {
    path: "kiten spaces",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // до сети, до резолва REF и до записи кэша справочников.
    argv: [],
    sampleResult: {
      spaces: [{ id: 100, title: "Разработка", archived: false }],
    },
  },
  {
    path: "kiten boards",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // до сети, --space здесь не резолвится.
    argv: [],
    sampleResult: {
      boards: [{ id: 4001, space_id: 100, title: "Основная" }],
    },
  },
  {
    path: "kiten lanes",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // до сети — скоуп «все доски компании» её и не достигает.
    argv: [],
    sampleResult: {
      lanes: [{ id: 6001, board_id: 4001, title: "Основная" }],
    },
  },
  {
    path: "kiten columns",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // до сети — тем же путём, что и `kiten lanes`.
    argv: [],
    sampleResult: {
      columns: [{ id: 5000001, board_id: 4001, title: "Готово" }],
    },
  },
  {
    path: "kiten roles",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // до сети и до записи таблицы ролей в кэш.
    argv: [],
    sampleResult: { roles: [{ id: 12058, name: "Техподдержка" }] },
  },
  {
    path: "kiten card",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // до сети и молча, как требует инвариант 1.
    argv: ["65634936"],
    sampleResult: {
      view: "md",
      card: {
        id: 65634936,
        key: null,
        title: "проба",
        state: "in progress",
        condition: 1,
        due_date: null,
        board: "Разработка",
        column: "Бэклог",
        lane: "Основная",
        size_text: null,
        created: "2026-08-14T16:32:53.473Z",
        updated: "2026-08-14T16:44:18.152Z",
        type: "Development",
        tags: ["срочно"],
        url: "https://kaiten.example.test/65634936",
        owner: null,
        members: [],
        properties: { id_291984: "гипотеза", id_610303: ["uid-файла"] },
        description: null,
        files: [],
        comments: [],
      },
      propertyNames: { id_291984: "6. Причина/гипотеза" },
    },
  },
  {
    path: "kiten comment",
    argv: ["65634936", "-m", "готово"],
    sampleResult: {
      id: 88017902,
      cardUrl: "https://kaiten.example.test/65634936",
      attachments: ["probe.txt"],
      recipients: ["@ivanov"],
    },
  },
  {
    path: "kiten field set",
    argv: [
      "65634936",
      "mr",
      "https://gitlab.example.test/m/r/-/merge_requests/9",
    ],
    sampleResult: {
      kind: "mr",
      value: "https://gitlab.example.test/m/r/-/merge_requests/9",
      cardUrl: "https://kaiten.example.test/65634936",
    },
  },
  {
    path: "kiten field artefact set",
    argv: ["65634936", "razbor.md"],
    sampleResult: {
      name: "razbor.md",
      fileUrl: "https://files/ec5402f3-a31f-4d18-9032-a4825cb004ba.md",
      cardUrl: "https://kaiten.example.test/65634936",
    },
  },
  {
    path: "kiten field artefact rm",
    argv: ["65634936"],
    sampleResult: {
      removed: ["razbor.md"],
      cardUrl: "https://kaiten.example.test/65634936",
    },
  },
  {
    path: "kiten time ls",
    argv: ["10000001"],
    sampleResult: {
      cardId: 10000001,
      totalMinutes: 75,
      logs: [SAMPLE_TIME_LOG],
    },
  },
  {
    path: "kiten time add",
    argv: ["10000001", "1h15m"],
    sampleResult: {
      log: SAMPLE_TIME_LOG,
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten time edit",
    argv: ["10000001", "7000001", "--time", "2h"],
    sampleResult: {
      log: SAMPLE_TIME_LOG,
      changed: ["time"],
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten time rm",
    argv: ["10000001", "7000001"],
    sampleResult: {
      log: SAMPLE_TIME_LOG,
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten time start",
    argv: ["10000001"],
    sampleResult: {
      startedAt: "2026-08-14T19:50:33.000+03:00",
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten time status",
    argv: ["10000001"],
    sampleResult: {
      cardId: 10000001,
      timer: {
        id: 5000001,
        started_at: "2026-08-14T19:50:33.000+03:00",
        elapsed_minutes: 1,
        comment: "проба таймера",
      },
      totalMinutes: 240,
    },
  },
  {
    path: "kiten time stop",
    argv: ["10000001"],
    sampleResult: {
      log: SAMPLE_TIME_LOG,
      logId: 7000001,
      factMinutes: 75,
      timeMinutes: null,
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten time discard",
    argv: ["10000001"],
    sampleResult: {
      elapsedMinutes: 1,
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten checklist ls",
    argv: ["10000001"],
    sampleResult: {
      checklists: [{
        id: 11960707,
        name: "Проверки",
        items: [{ id: 66835645, checked: false, text: "Тест написан" }],
      }],
    },
  },
  {
    path: "kiten checklist add",
    argv: ["10000001", "-n", "Проверки", "-i", "Тест написан"],
    sampleResult: {
      name: "Проверки",
      checklistId: 11960707,
      created: true,
      added: 1,
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten checklist check",
    argv: ["10000001", "Тест"],
    sampleResult: {
      checked: true,
      text: "Тест написан",
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten checklist uncheck",
    argv: ["10000001", "66835645"],
    sampleResult: {
      checked: false,
      text: "Тест написан",
      cardUrl: "https://kaiten.example.test/10000001",
    },
  },
  {
    path: "kiten move",
    // Ни одной оси: вызов обязан отбиться до сети, как требует
    // инвариант 1 (сеанса Kaiten у обхода нет).
    argv: ["10000001"],
    sampleResult: {
      cardUrl: "https://kaiten.example.test/10000001",
      from: "Разработка · Бэклог · Веб",
      to: "Разработка · Готово · Веб",
      relog: false,
      column: { id: 5620663, title: "Готово" },
      dryRun: false,
    },
  },
  {
    path: "kiten ready",
    argv: ["abc"],
    sampleResult: {
      cardUrl: "https://kaiten.example.test/10000001",
      from: "Разработка · Готово · Веб",
      to: "Разработка · Готово · Веб",
      relog: true,
      column: { id: 5620663, title: "Готово" },
      dryRun: false,
    },
  },
  {
    path: "kiten review",
    argv: ["abc"],
    sampleResult: {
      cardUrl: "https://kaiten.example.test/10000001",
      from: "Разработка · Бэклог · Веб",
      to: null,
      relog: false,
      column: { id: 5620664, title: "Код-ревью" },
      dryRun: true,
    },
  },
  {
    path: "kiten close",
    argv: ["10000001", "--done", "Починили", "--dry-run"],
    sampleResult: {
      cardId: 10000001,
      cardUrl: "https://kaiten.example.test/10000001",
      dryRun: true,
      timer: null,
      stopped: null,
      written: ["done"],
      skipped: [],
      reply: null,
      move: {
        columnId: 5000001,
        columnTitle: "Готово",
        relog: false,
        from: "Проекты · Бэклог · Разработка",
        to: null,
      },
    },
  },
  {
    path: "kiten ls",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // на резолве доступа, до запроса `getCurrentUser` и до чтения кэша.
    argv: [],
    sampleResult: {
      view: "table",
      rows: [{
        id: 65634936,
        state: "in progress",
        due_date: null,
        updated: "2026-08-14T16:44:18.152Z",
        title: "проба",
        url: "https://kaiten.example.test/65634936",
        column: "Бэклог",
        columnMapped: "Бэклог",
      }],
    },
  },
  {
    path: "kiten status",
    // Ключа `KITEN_API_KEY` во временном окружении нет: вызов отказывает
    // на резолве доступа, до запроса `getCurrentUser` и до сбора
    // источников (карточки, время, лента действий).
    argv: [],
    sampleResult: {
      rows: [{
        id: 65634936,
        title: "проба",
        url: "https://kaiten.example.test/65634936",
        stage: "work",
        column: "Бэклог",
        board: "Разработка",
        space: "Основная",
        lane: "Основная",
        state: "in progress",
        closed: false,
        escalated: false,
        due_date: null,
        updated: "2026-08-14T16:44:18.152Z",
        my_minutes: 75,
        sources: ["assigned", "time"],
      }],
      out: "matrix",
      format: null,
      minutesByRole: { "Техподдержка": 75 },
      now: 1786700096,
    },
  },
  {
    path: "telegram ls",
    // Сеанса Telegram у обхода нет: вызов обязан отбиться до сети —
    // здесь на разборе --limit.
    argv: ["--limit", "0"],
    sampleResult: {
      dialogs: [{
        id: 100000001,
        title: "Иван Петров",
        kind: "user",
        username: "ipetrov",
      }],
      table: false,
    },
  },
  {
    path: "telegram search",
    // Сеанса Telegram у обхода нет: вызов обязан отбиться до сети —
    // здесь на пустом глобальном поиске.
    argv: [],
    sampleResult: {
      messages: [{
        id: 4821,
        chat_id: -1000000000101,
        chat_title: "Команда выгрузок",
        sender: "Иван Петров",
        date: "2026-08-16T07:54:28+00:00",
        text: "выгрузка за июль готова",
        link: "https://t.me/team_uploads/4821",
      }],
      table: false,
    },
  },
  {
    path: "telegram status",
    // Адресата нет ни во флаге, ни в env-файле обхода: вызов обязан
    // отбиться до сети и до кэш-БД — их у обхода нет.
    argv: [],
    sampleResult: {
      text:
        "Отчёт за сегодня (2026-08-17 МСК):\n\nСегодня перемещений не было.",
      sent: null,
    },
  },
  {
    path: "telegram send",
    // Адресата нет ни во флаге, ни в env-файле обхода: вызов обязан
    // отбиться до сети — сеанса Telegram у обхода нет.
    argv: ["привет"],
    sampleResult: {
      id: 5000001,
      chat_id: 100000001,
      date: "2026-08-16T08:04:09+00:00",
    },
  },
  {
    // Обёртки очередей и миграций: селектор — сам сервер, `--client-id`
    // у них нет вовсе. Кэш-БД обхода пуст, поэтому вызов отбивается на
    // резолве, до сети.
    path: "wb-jobs show",
    argv: ["sl-9"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "data-loader-jobs show",
    argv: ["sl-9"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-jobs show",
    argv: ["sl-9"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-jobs prune",
    argv: ["sl-9"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "app-migrations latest",
    argv: ["sl-9"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "app-migrations up",
    argv: ["sl-9"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "clients-migrations latest",
    argv: ["777", "--type", "wb"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "clients-migrations up",
    argv: ["777", "--type", "wb"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "clients-migrations rollback",
    argv: ["777", "--type", "wb"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "clients-migrations down",
    argv: ["777", "--type", "wb"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "clients-migrations init",
    argv: ["777", "--type", "wb"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "clients-migrations latest-all",
    argv: ["sl-9", "--type", "wb"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "datasets-migrations latest",
    argv: ["777", "--dataset", "wb_unit"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "datasets-migrations up",
    argv: ["777", "--dataset", "wb_unit"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "datasets-migrations rollback",
    argv: ["777", "--dataset", "wb_unit"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "datasets-migrations down",
    argv: ["777", "--dataset", "wb_unit"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "datasets-migrations list",
    argv: ["777", "--dataset", "wb_unit"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-loader postings-reports",
    argv: ["777", "--seller-client-id", "999001"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-loader performance-reports",
    argv: ["777", "--seller-client-id", "999001"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-loader search-promo",
    argv: ["777", "--seller-client-id", "999001"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-loader campaign-daily-statistics",
    argv: ["777", "--seller-client-id", "999001"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-loader campaigns",
    argv: ["777", "--seller-client-id", "999001"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-loader transactions",
    argv: ["777", "--seller-client-id", "999001"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ozon-loader load-data",
    argv: ["777", "--seller-client-id", "999001"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    // Штучные обёртки: три из пяти листовые (в рабочей версии группы с
    // единственной подкомандой схлопнуты typer'ом).
    path: "ss-load",
    argv: ["777", "--dataset", "wb_unit"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "ss-datasets",
    argv: ["777", "--dataset", "wb_unit"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "wb-unit-calc",
    argv: ["777", "--nm-id", "123"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "wb-unit-proto-new",
    argv: ["777"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "users add",
    argv: ["sl-9", "--email", "probe@example.com"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    path: "users add-role",
    argv: ["sl-9", "--id", "42", "--role", "client"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    // Пересчёт витрин: у обхода нет ни env-файла, ни кэша — вызов
    // отбивается на резолве, до сети.
    path: "process",
    argv: ["777", "-p"],
    sampleResult: SAMPLE_WRAP,
  },
  {
    // Локальный стенд: docker в обходе не запускается, вызов
    // отбивается на резолве селектора.
    path: "make-schema",
    argv: ["777", "-p"],
    sampleResult: {
      container: "mp-sl-1-cli",
      command: "docker exec mp-sl-1-cli node cli service:clientsMigrations" +
        " init --client-id 777 --server sl-1",
      printed: "docker exec mp-sl-1-cli node cli service:clientsMigrations" +
        " init --client-id 777 --server sl-1",
      output: "",
      exitCode: 0,
    },
  },
  {
    // Резолв цели без сети: у обхода нет ни кэша, ни настроек, поэтому
    // вызов отбивается на отсутствии цели.
    path: "sheet resolve",
    argv: [],
    sampleResult: {
      ss_id: "1SyntheticSpreadsheetIdForGoldens0000000000",
      source: "flag",
      kind: "id",
      original_input: "1SyntheticSpreadsheetIdForGoldens0000000000",
    },
  },
  {
    path: "sheet ls",
    argv: [],
    sampleResult: {
      tabs: [{ title: "Sheet1", sheet_id: 0, rows: 1000, cols: 26, index: 0 }],
    },
  },
  {
    path: "sheet get",
    argv: ["Sheet1!A1:B2"],
    sampleResult: {
      spreadsheetId: "1SyntheticSpreadsheetIdForGoldens0000000000",
      valueRanges: [{
        range: "Sheet1!A1:B2",
        values: [["привет", 42], ["", 84]],
        formulas: [["привет", 42], ["", "=B1*2"]],
        fromCache: true,
      }],
    },
  },
  {
    // Считает локально: ни сети, ни io — обход проходит её целиком.
    path: "sun",
    argv: ["--date", "2026-08-27"],
    sampleResult: {
      date: "2026-08-27",
      latitude: 55.693516,
      longitude: 37.967941,
      timezone: "UTC+03:00",
      sunrise: "2026-08-27 05:23:03",
      solar_noon: "2026-08-27 12:29:42",
      sunset: "2026-08-27 19:35:02",
      day_length: "14:11:59",
    },
  },
  {
    // Копии таблиц: у обхода нет ни env-файла с адресом сервера, ни
    // кэша — вызов отбивается на резолве, до соединения.
    path: "backup-wb-unit-proto",
    argv: ["777", "--dry"],
    sampleResult: SAMPLE_BACKUP,
  },
  {
    path: "backup-ozon-unit-proto",
    argv: ["777", "--dry"],
    sampleResult: { ...SAMPLE_BACKUP, marketplace: "ozon" },
  },
  {
    path: "backup-wb-unit-manual-data",
    argv: ["777", "--dry"],
    sampleResult: SAMPLE_BACKUP,
  },
  {
    // Ворота пайпа: stdin у обхода пуст, терминала нет — вызов
    // отбивается до всякого вопроса.
    path: "confirm",
    argv: [],
    sampleResult: { text: '{"ok": true}\n' },
  },
  {
    path: "claude-hook notification",
    // Весь вход команды — stdin; у обхода он пуст, поэтому вызов
    // обязан отбиться разбором payload'а, до конфигурации и сети.
    argv: [],
    sampleResult: { id: 5000001 },
  },
  // Семейство `mr`: ключа GLAB_TOKEN в env-файле обхода нет, поэтому
  // каждый вызов обязан отбиться на конфигурации — до git и до сети.
  {
    path: "mr view",
    argv: ["--mr", "group/repo!456"],
    sampleResult: {
      project: "group/repo",
      iid: 456,
      title: "заголовок",
      state: "opened",
      source_branch: "feat/branch",
      target_branch: "main",
      web_url: "https://gitlab.example.test/group/repo/-/merge_requests/456",
      author_name: "Имя Фамилия",
      author_username: "user",
      description: "",
      diff_refs: null,
      project_id: 1001,
      sha: null,
      merge_commit_sha: null,
      squash_commit_sha: null,
    },
  },
  {
    path: "mr files",
    argv: ["--mr", "group/repo!456"],
    sampleResult: {
      files: [{
        status: "M",
        old_path: "src/file.ts",
        new_path: "src/file.ts",
        additions: 2,
        deletions: 1,
      }],
    },
  },
  {
    path: "mr diff",
    argv: ["--mr", "group/repo!456"],
    sampleResult: {
      files: [{
        old_path: "src/file.ts",
        new_path: "src/file.ts",
        diff: "@@ -1,1 +1,2 @@\n-раз\n+один\n+два\n",
        new_file: false,
        renamed_file: false,
        deleted_file: false,
      }],
    },
  },
  {
    path: "mr comments",
    argv: ["--mr", "group/repo!456"],
    sampleResult: {
      headline: "MR group/repo!456 — заголовок [opened]",
      threads: [],
    },
  },
  {
    path: "mr show",
    argv: ["953d395b", "--mr", "group/repo!456"],
    sampleResult: {
      id: "953d395bb1c317b7317d46193627708c31882800",
      resolvable: false,
      resolved: false,
      location: null,
      notes: [],
    },
  },
  // Пишущие подкоманды `mr`: у обхода нет GLAB_TOKEN, поэтому каждая
  // обязана отбиться на конфигурации либо на разборе входа — до сети.
  {
    path: "mr create",
    argv: [
      "--title",
      "заголовок",
      "--target",
      "main",
      "--project",
      "group/repo",
    ],
    sampleResult: {
      project: "group/repo",
      iid: 7,
      title: "заголовок",
      state: "opened",
      source_branch: "feat/branch",
      target_branch: "main",
      url: "https://gitlab.example.test/group/repo/-/merge_requests/7",
    },
  },
  {
    path: "mr describe",
    argv: ["--mr", "group/repo!456", "-m", "новое описание"],
    sampleResult: {
      project: "group/repo",
      iid: 456,
      url: "https://gitlab.example.test/group/repo/-/merge_requests/456",
    },
  },
  {
    path: "mr comment",
    argv: ["src/module.txt:8", "--mr", "group/repo!456", "-m", "замечание"],
    sampleResult: {
      discussion: "a1b2c3d400000000000000000000000000000000",
      note_id: 6,
      path: "src/module.txt",
      line: 8,
      url: "https://gitlab.example.test/group/repo/-/merge_requests/456#note_6",
    },
  },
  {
    path: "mr note",
    argv: ["--mr", "group/repo!456", "-m", "общий комментарий"],
    sampleResult: {
      discussion: "a1b2c3d400000000000000000000000000000000",
      note_id: 7,
      url: "https://gitlab.example.test/group/repo/-/merge_requests/456#note_7",
    },
  },
  {
    path: "mr reply",
    argv: ["a1b2c3d4", "--mr", "group/repo!456", "-m", "ответ"],
    sampleResult: {
      discussion: "a1b2c3d400000000000000000000000000000000",
      note_id: 8,
      url: "https://gitlab.example.test/group/repo/-/merge_requests/456#note_8",
    },
  },
  {
    path: "mr edit",
    argv: ["6", "--mr", "group/repo!456", "-m", "уточнил"],
    sampleResult: { note_id: 6 },
  },
  {
    path: "mr delete",
    // С `--yes`: терминала у обхода нет, а проверить надо отказ
    // конфигурации, а не отсутствие TTY.
    argv: ["6", "--mr", "group/repo!456", "--yes"],
    sampleResult: { note_id: 6 },
  },
  {
    path: "mr resolve",
    argv: ["a1b2c3d4", "--mr", "group/repo!456"],
    sampleResult: {
      discussion: "a1b2c3d400000000000000000000000000000000",
      resolved: true,
    },
  },
  {
    path: "mr unresolve",
    argv: ["a1b2c3d4", "--mr", "group/repo!456"],
    sampleResult: {
      discussion: "a1b2c3d400000000000000000000000000000000",
      resolved: false,
    },
  },
  {
    // Локальная команда: обход зовёт её на чтение — хранилище в
    // временном каталоге образца, записи в нём нет.
    path: "config",
    argv: ["sheet.default"],
    sampleResult: {
      entries: [{
        key: "sheet.default",
        value: null,
        source: "default",
        default: null,
        description:
          "Spreadsheet по умолчанию (ID/URL/alias/client_id/title) для `mpu sheet`",
      }],
      action: "get",
    },
  },
  {
    // Локальный стенд: у обхода нет ни каталога mp-config-local, ни
    // ключей подключений, поэтому обе отбиваются до docker и до PG.
    path: "mp-init",
    argv: ["--dry-run"],
    sampleResult: {
      steps: ["$ docker compose -f /nowhere/compose.yaml up -d"],
      web: false,
      dryRun: true,
      exitCode: 0,
    },
  },
  {
    path: "clean-local-clients",
    argv: [],
    sampleResult: {
      clients: [54, 1498],
      keep: [54, 776],
      targets: [1498],
      deleted: 0,
      workspaces: 0,
      dryRun: true,
    },
  },
  // Копирования. Образец — для инвариантов рендера и сериализации; сам
  // вызов отбивается до pg_dump и до docker: у обхода нет ни кэша с
  // клиентом, ни ключей подключений.
  {
    path: "copy-client",
    argv: ["5175"],
    sampleResult: {
      clientId: 5175,
      schema: "schema_5175",
      sl1: [{ table: "clients", rows: 1 }],
      sl0: [{ table: "clients", rows: 1 }],
      login: true,
    },
  },
  {
    path: "copy-shared",
    argv: ["sl-1"],
    sampleResult: {
      command: "docker compose -f /nowhere/compose.sl-dt-host.yaml exec -i cli",
      exitCode: 0,
    },
  },
  {
    path: "copy-dev",
    argv: [],
    sampleResult: { mode: "workspaces", clientId: null },
  },
  // Переносы. Образец результата нужен инвариантам 2 и 6 (рендер и
  // сериализация) и исполнением не проверяется: у обхода нет ни кэша с
  // клиентом, ни Portainer-доступа, поэтому сам вызов отбивается до
  // постановки задачи.
  {
    path: "move-client",
    argv: ["1234", "--target", "sl-4"],
    sampleResult: {
      clientId: 1234,
      source: "sl-3",
      target: "sl-4",
      exitCode: 0,
      recorded: true,
    },
  },
  {
    path: "move-client-back",
    argv: ["ls"],
    sampleResult: { action: "ls", moves: [], removed: false, exitCode: 0 },
  },
  {
    path: "telegram log",
    // Ключей бота в env-файле обхода нет: вызов обязан отбиться на
    // конфигурации, до сети.
    argv: ["заметка"],
    sampleResult: { id: 5000001 },
  },
];

Deno.test("реестр непуст и покрыт образцами вызова", () => {
  assert(commands.length > 0, "реестр пуст: обходить нечего");
  const registered = commands.map((c) => c.path.join(" ")).sort();
  const covered = CASES.map((c) => c.path).sort();
  assertEquals(covered, registered, "таблица образцов разошлась с реестром");
});

Deno.test("инвариант 1: исполнение не печатает", async () => {
  await withSampleDir(async (dir) => {
    for (const testCase of CASES) {
      const command = mustFind(testCase.path);
      const captured = await withCapturedOutput(async () => {
        try {
          await command.invoke(testCase.argv, makeIo(dir));
        } catch {
          // Инвариант — про печать, а не про успех: команда, которой в
          // тестовом окружении не хватает внешней системы (`init` без
          // конфигурации Portainer), обязана молчать и в отказе.
        }
      });
      assertEquals(
        captured,
        "",
        `${testCase.path} писала в приёмник вывода: ${captured}`,
      );
    }
  });
});

Deno.test("инвариант 2: рендер чист", () => {
  for (const testCase of CASES) {
    const command = mustFind(testCase.path);
    // Литеральный результат, вне окружения: io команде не передаётся.
    const first = command.renderResult(testCase.sampleResult, testCase.argv);
    const second = command.renderResult(testCase.sampleResult, testCase.argv);
    assertEquals(second, first, `${testCase.path}: рендер не воспроизводим`);
  }
});

Deno.test("инвариант 3: политика объявлена и не зависит от аргументов", () => {
  for (const command of commands) {
    const name = command.path.join(" ");
    assert(
      command.policy === "ro" || command.policy === "rw",
      `${name}: политика не объявлена`,
    );
    // Значения аргументов на политику не влияют: класс команды не
    // выводится из входа (отклонение-fix про `--print` и `--dry`).
    const before = command.policy;
    for (const input of command.inputs) {
      command.parseArgs(argvFor(command, [...required(command), input.name]));
      assertEquals(
        command.policy,
        before,
        `${name}: политика изменилась после разбора "${input.name}"`,
      );
    }
  }
});

Deno.test("инвариант 4: имена входа совпадают со схемой аргументов", () => {
  for (const command of commands) {
    const name = command.path.join(" ");
    const schemaNames = Object.keys(command.argsJsonSchema.properties);
    // Каждое имя схемы разбор argv действительно принимает: переданное
    // значение доезжает до разобранных аргументов под тем же именем.
    // Обязательные входы добавляются, иначе разбор упадёт раньше.
    for (const input of command.inputs) {
      const argv = argvFor(command, [
        ...required(command),
        ...positionalsBefore(command, input.name),
        input.name,
      ]);
      const parsed = command.parseArgs(argv);
      assertEquals(
        parsed[input.name],
        sampleValue(command, input),
        `${name}: вход "${input.name}" не принят из argv`,
      );
    }
    assertEquals(
      command.inputs.map((input) => input.name).sort(),
      [...schemaNames].sort(),
      `${name}: схема объявляет входы, которых нет у разбора argv`,
    );
    // Короткая форма — то же имя схемы, записанное иначе.
    for (const input of command.inputs) {
      if (input.form.short === undefined) continue;
      const value = sampleValue(command, input);
      const written = input.kind === "boolean"
        ? [`-${input.form.short}`]
        : [`-${input.form.short}`, String(value)];
      const parsed = command.parseArgs([...requiredArgv(command), ...written]);
      assertEquals(
        parsed[input.name],
        value,
        `${name}: короткая форма "-${input.form.short}" не принята`,
      );
    }
    // И ничего сверх схемы: постороннее имя отвергается как опция.
    // Исключение — вход, объявивший `keepsUnknown`: у него хвост argv
    // это чужая командная строка (`mpu ssh`), и неопознанный токен по
    // объявлению уходит в него, а не становится отказом.
    const catchAll = command.inputs.find((input) =>
      input.form.keepsUnknown === true
    );
    if (catchAll !== undefined) {
      const parsed = command.parseArgs([
        ...requiredArgv(command),
        "--нет-такого-входа",
      ]);
      const positional = command.inputs
        .filter((input) => input.form.positional !== undefined)
        .flatMap((input) => [parsed[input.name]].flat());
      assertEquals(
        positional.includes("--нет-такого-входа"),
        true,
        `${name}: неопознанный токен не дошёл до позиционных входов`,
      );
      continue;
    }
    // У команды без записи аргументов в журнал имя опции в сообщении
    // заменено на REDACTED: её ввод персонален, а секции err записи
    // журнала пишутся как обычно (`command/args.ts`, `ParseOptions`).
    const err = assertThrows(
      () => command.parseArgs([...requiredArgv(command), "--нет-такого-входа"]),
      UsageError,
      command.logsArguments
        ? `unknown option "--нет-такого-входа"`
        : "unknown option REDACTED",
    );
    assertEquals(err.hint, `mpu ${name} --help`);
  }
});

Deno.test("инвариант 5: обязательность совпадает", () => {
  for (const command of commands) {
    const name = command.path.join(" ");
    const names = command.requiredInputNames;
    // Набора из одних обязательных хватает: необязательные входы можно
    // не писать в argv. Полный набор здесь не проверяется — у команды
    // бывают взаимоисключающие входы (`--raw` и `--tsv` у get).
    command.parseArgs(requiredArgv(command));
    for (const missing of names) {
      const kept = names.filter((input) => input !== missing);
      assertThrows(
        () => command.parseArgs(argvFor(command, kept)),
        UsageError,
        undefined,
        `${name}: без обязательного "${missing}" разбор не упал`,
      );
    }
    // Параметр со значением по умолчанию не обязателен ни там, ни там.
    for (
      const [key, field] of Object.entries(command.argsJsonSchema.properties)
    ) {
      if (field.default === undefined) continue;
      assert(
        !names.includes(key),
        `${name}: "${key}" имеет значение по умолчанию и обязателен`,
      );
    }
  }
});

/** argv, записывающий перечисленные входы: сначала флаги, потом позиционные. */
function argvFor(command: Command, names: readonly string[]): string[] {
  const flags: string[] = [];
  const positional: string[] = [];
  for (const input of command.inputs) {
    if (!names.includes(input.name)) continue;
    const value = sampleValue(command, input);
    if (input.form.positional !== undefined) {
      positional.push(Array.isArray(value) ? String(value[0]) : String(value));
      continue;
    }
    if (input.kind === "boolean") {
      flags.push(`--${input.name}`);
      continue;
    }
    flags.push(
      `--${input.name}`,
      Array.isArray(value) ? `${value[0]}` : `${value}`,
    );
  }
  return [...flags, ...positional];
}

/**
 * Позиционные входы, объявленные раньше названного. Позиционное
 * значение занимает своё место по порядку объявления: у команды с двумя
 * необязательными позиционными (`mpu logs`) второй нельзя записать в
 * argv, не записав первый, — иначе значение достанется первому и
 * проверка сравнивала бы не тот вход.
 */
function positionalsBefore(command: Command, name: string): string[] {
  const earlier: string[] = [];
  for (const input of command.inputs) {
    if (input.name === name) break;
    if (input.form.positional !== undefined) earlier.push(input.name);
  }
  return earlier;
}

function requiredArgv(command: Command): string[] {
  return argvFor(command, required(command));
}

function required(command: Command): readonly string[] {
  return command.requiredInputNames;
}

/** Что окажется в разобранных аргументах, если записать вход в argv. */
function sampleValue(
  command: Command,
  input: Command["inputs"][number],
): unknown {
  if (input.kind === "boolean") return true;
  // Образец подбирается по объявленному типу входа, а не один на всех:
  // у перечисления это допустимое значение, у числового входа — число (в
  // argv оно пишется текстом, а в разобранных аргументах уже число), у
  // числового списка — список чисел, остальным годится короткая строка
  // без спецсимволов. Иначе вход с типизированными значениями нельзя
  // объявить схемой вовсе — обход подставлял бы ему `x`.
  if (input.kind === "number") return 1;
  if (input.kind === "numbers") return [1];
  const allowed = command.argsJsonSchema.properties[input.name]?.enum;
  const value = allowed === undefined ? "x" : String(allowed[0]);
  return input.kind === "strings" ? [value] : value;
}

Deno.test("инвариант 6: результат сериализуем без потерь", () => {
  for (const testCase of CASES) {
    const command = mustFind(testCase.path);
    const restored = JSON.parse(JSON.stringify(testCase.sampleResult));
    assertEquals(
      restored,
      testCase.sampleResult,
      `${testCase.path}: результат не переживает JSON`,
    );
    // Образец обязан удовлетворять объявленной схеме результата, иначе
    // проверка сериализации сверяет не то, что команда возвращает.
    command.assertResult(testCase.sampleResult);
  }
});

Deno.test("инвариант 7: результат — объект в корне", () => {
  for (const command of commands) {
    assertEquals(
      command.resultJsonSchema.type,
      "object",
      `${command.path.join(" ")}: корень схемы результата не объект`,
    );
  }
});

function mustFind(path: string): Command {
  const command = findCommand(path.split(" "));
  assert(command !== undefined, `команда "${path}" не зарегистрирована`);
  return command;
}

/**
 * Приёмник вывода процесса на время вызова: инвариант 1 требует, чтобы
 * исполнение не печатало, а печать в Deno идёт мимо io команды — через
 * console и потоки процесса.
 */
async function withCapturedOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  // Перехватываются все пути печати процесса, а не только привычные:
  // проверка обязана ловить и console.warn, и синхронную запись в
  // поток, иначе «ничего не напечатано» доказывает слишком мало.
  const levels = ["log", "error", "warn", "info", "debug"] as const;
  const origConsole = levels.map((level) => console[level]);
  const origWrite = [Deno.stdout.write, Deno.stderr.write];
  const origWriteSync = [Deno.stdout.writeSync, Deno.stderr.writeSync];
  for (const level of levels) {
    console[level] = (...args: unknown[]) => void chunks.push(args.join(" "));
  }
  for (const stream of [Deno.stdout, Deno.stderr]) {
    stream.write = (bytes: Uint8Array) => {
      chunks.push(decoder.decode(bytes));
      return Promise.resolve(bytes.length);
    };
    stream.writeSync = (bytes: Uint8Array) => {
      chunks.push(decoder.decode(bytes));
      return bytes.length;
    };
  }
  try {
    await fn();
  } finally {
    levels.forEach((level, i) => void (console[level] = origConsole[i]));
    Deno.stdout.write = origWrite[0];
    Deno.stderr.write = origWrite[1];
    Deno.stdout.writeSync = origWriteSync[0];
    Deno.stderr.writeSync = origWriteSync[1];
  }
  return chunks.join("");
}

/** Каталог с книгой-фикстурой: команды обхода читают настоящий файл. */
async function withSampleDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    // Книга-фикстура лежит в тестовом каталоге команды xlsx: копировать
    // её второй раз незачем, источник истины у обеих копий один —
    // docs/specs/fixtures/xlsx.
    const base64 = await Deno.readTextFile(
      new URL("../xlsx/testdata/sample.xlsx.b64", import.meta.url),
    );
    const binary = atob(base64.replaceAll(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.codePointAt(0) ?? 0);
    await Deno.writeFile(`${dir}/sample.xlsx`, bytes);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Настоящие чтение и запись в пределах временного каталога. */
function makeIo(dir: string): CommandIo {
  const inDir = (path: string) =>
    path.startsWith("/") ? path : `${dir}/${path}`;
  return {
    env: () => undefined,
    cwd: () => dir,
    readFile: (path) => Deno.readFile(inDir(path)),
    readRegularFile: (path) => Deno.readFile(inDir(path)),
    readTextFile: (path) => Deno.readTextFile(inDir(path)),
    readStdin: () => Promise.resolve(new TextEncoder().encode("")),
    stdinIsTerminal: () => false,
    stdoutIsTerminal: () => false,
    stderrIsTerminal: () => false,
    note: () => {},
    // Терминала у обхода нет: вопрос человеку в прогоне задать некому,
    // и команда-ворота обязана это заметить, а не ждать ответа.
    openTerminal: () => Promise.resolve(undefined),
    currentShell: () => undefined,
    appendFile: (path, text) =>
      Deno.writeTextFile(inDir(path), text, {
        append: true,
        create: true,
      }),
    runLegacy: () => {
      throw new Error("legacy must not be touched");
    },
    runLegacyInteractive: () => {
      throw new Error("legacy must not be touched");
    },
    envFile: {
      // Резолв пути xlsx (`settings.ts`) зовёт `get` безусловно ещё до
      // проверки источников — молчаливое отсутствие ключа здесь то же
      // самое, чем был `env: () => undefined` до переезда MPU_XLSX в
      // env-файл (2026-08-05, env-file.md).
      get: () => undefined,
      require: () => {
        throw new Error("envFile must not be touched");
      },
      set: () => {
        throw new Error("envFile must not be touched");
      },
      values: () => ({}),
    },
    readAccessToken: () => Promise.resolve("проба-токена"),
    writeAccessToken: (token) =>
      Deno.writeTextFile(`${dir}/token`, token, { mode: 0o600 }),
    // Запуск открывателя в обходе не нужен: образец зовёт open с --print.
    launchOpener: () => false,
    // Настоящая кэш-БД во временном каталоге: `mpu init` открывает её
    // и создаёт схему первым же шагом, до всякой проверки конфигурации.
    openCacheDb: () => openStoreDb(`${dir}/mpu.db`),
    // Порт диагностики хода исполнения — не приёмник вывода: контракт
    // разрешает командам писать в него, печатает точка входа
    // (`platform/command-contract.md`, инвариант 1). Поэтому здесь он
    // молча глотает строки, а не падает.
    progress: () => {},
    // Приёмник вывода удалённой команды: до транспорта образцы обхода не
    // доходят (`ssh` отказывает на пустой команде), поэтому обращение к
    // нему — сигнал, что образец ушёл в живой контейнер.
    openRemoteOutput: () => {
      throw new Error("openRemoteOutput must not be touched");
    },
  };
}

Deno.test("каждый промежуточный уровень пути опознаётся реестром", () => {
  // Точка входа опознаёт сегмент пути только по реестру: группой либо
  // записью слепка. Не описан ни там ни там — подкоманды
  // зарегистрированы, но человеком не вызываются вовсе
  // (`platform/registry.md`, справка на каждом уровне).
  for (const command of commands) {
    for (let depth = 1; depth < command.path.length; depth++) {
      const prefix = command.path.slice(0, depth);
      const known = findGroup(prefix) !== undefined ||
        findLegacy(prefix) !== undefined;
      assert(
        known,
        `${command.path.join(" ")}: уровень "${prefix.join(" ")}" не описан`,
      );
    }
  }
});
