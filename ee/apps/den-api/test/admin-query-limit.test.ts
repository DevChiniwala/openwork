import assert from "node:assert/strict"
import { test } from "node:test"
import { isDatabaseTimeLimitError, withDatabaseTimeLimit } from "../src/mcp/admin-query-limit.js"

const hint = "/*+ MAX_EXECUTION_TIME(14000) */ /*vt+ QUERY_TIMEOUT_MS=14000 */"

test("a SELECT carries the time limit to the database", () => {
  assert.equal(
    withDatabaseTimeLimit("SELECT org_id, COUNT(*) FROM audit_event GROUP BY org_id LIMIT 200", 14_000),
    `SELECT ${hint} org_id, COUNT(*) FROM audit_event GROUP BY org_id LIMIT 200`,
  )
})

test("a WITH statement gets it on the SELECT after its CTEs, not inside one", () => {
  const sqlText = "WITH recent AS (SELECT org_id FROM audit_event WHERE created_at > NOW() - INTERVAL 1 DAY) SELECT org_id, COUNT(*) FROM recent GROUP BY org_id"
  assert.equal(
    withDatabaseTimeLimit(sqlText, 14_000),
    `WITH recent AS (SELECT org_id FROM audit_event WHERE created_at > NOW() - INTERVAL 1 DAY) SELECT ${hint} org_id, COUNT(*) FROM recent GROUP BY org_id`,
  )
})

test("quoted text, identifiers and comments that say select are left alone", () => {
  const sqlText = "/* select count */ -- select\nSELECT 'select' AS `select`, \"it's select\" FROM t"
  assert.equal(
    withDatabaseTimeLimit(sqlText, 14_000),
    `/* select count */ -- select\nSELECT ${hint} 'select' AS \`select\`, "it's select" FROM t`,
  )
  assert.equal(withDatabaseTimeLimit("SELECT selected, select_count FROM t", 14_000), `SELECT ${hint} selected, select_count FROM t`)
})

test("an existing optimizer hint is joined, since MySQL reads one hint comment per query block", () => {
  assert.equal(
    withDatabaseTimeLimit("SELECT /*+ INDEX(a audit_event_org_id) */ * FROM audit_event a", 14_000),
    "SELECT /*+ MAX_EXECUTION_TIME(14000) INDEX(a audit_event_org_id) */ /*vt+ QUERY_TIMEOUT_MS=14000 */ * FROM audit_event a",
  )
})

test("EXPLAIN limits the statement it runs; SHOW and DESCRIBE are unchanged", () => {
  assert.equal(withDatabaseTimeLimit("EXPLAIN ANALYZE SELECT * FROM audit_event", 14_000), `EXPLAIN ANALYZE SELECT ${hint} * FROM audit_event`)
  assert.equal(withDatabaseTimeLimit("SHOW FULL PROCESSLIST", 14_000), "SHOW FULL PROCESSLIST")
  assert.equal(withDatabaseTimeLimit("DESCRIBE audit_event", 14_000), "DESCRIBE audit_event")
})

test("a database time-limit stop is recognized through the driver's wrapped errors", () => {
  const mysql = Object.assign(new Error("Query execution was interrupted, maximum statement execution time exceeded"), { errno: 3024 })
  assert.equal(isDatabaseTimeLimitError(new Error("Failed query: SELECT 1", { cause: mysql })), true)
  assert.equal(isDatabaseTimeLimitError(new Error("Failed query", { cause: new Error("target: den.-.primary: vttablet: rpc error: code = DeadlineExceeded desc = context deadline exceeded") })), true)
  assert.equal(isDatabaseTimeLimitError(new Error("Failed query", { cause: new Error("Unknown column 'nope' in 'field list'") })), false)
})
