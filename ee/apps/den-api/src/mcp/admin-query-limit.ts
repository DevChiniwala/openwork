/**
 * Make the database stop an admin SQL statement at its time limit.
 *
 * den_query races a timer in Den, but losing that race does not cancel the
 * statement: MySQL keeps scanning after Den has answered "time limit
 * exceeded", so one unindexed audit query could hold the database for minutes.
 * The limit has to reach the database. MySQL's MAX_EXECUTION_TIME optimizer
 * hint and Vitess's QUERY_TIMEOUT_MS directive both do that for a SELECT, and
 * both must sit directly after the statement's top-level SELECT keyword.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

const TIME_LIMIT_ERROR = /maximum statement execution time exceeded|\b3024\b|query timeout|deadline exceeded/i

/** Whether the database stopped the statement at its time limit (MySQL error 3024 or a Vitess query timeout). */
export function isDatabaseTimeLimitError(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false
  const record = error as Record<string, unknown>
  if (record.errno === 3024 || record.code === "ER_QUERY_TIMEOUT") return true
  if (typeof record.message === "string" && TIME_LIMIT_ERROR.test(record.message)) return true
  return isDatabaseTimeLimitError(record.cause, depth + 1)
}

/** The index just past the top-level SELECT keyword, skipping quotes, comments and parentheses. */
function topLevelSelectEnd(sqlText: string): number | null {
  let depth = 0
  for (let index = 0; index < sqlText.length; index++) {
    const char = sqlText[index]!
    const next = sqlText[index + 1]
    if (char === "'" || char === "\"" || char === "`") {
      for (index++; index < sqlText.length; index++) {
        if (sqlText[index] === "\\" && char !== "`") index++
        else if (sqlText[index] === char) {
          if (sqlText[index + 1] === char) index++
          else break
        }
      }
    } else if (char === "/" && next === "*") {
      const end = sqlText.indexOf("*/", index + 2)
      index = end === -1 ? sqlText.length : end + 1
    } else if ((char === "-" && next === "-") || char === "#") {
      const end = sqlText.indexOf("\n", index)
      index = end === -1 ? sqlText.length : end
    } else if (char === "(") {
      depth++
    } else if (char === ")") {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && /[sS]/.test(char)
      && sqlText.slice(index, index + 6).toLowerCase() === "select"
      && !/[\w$]/.test(sqlText[index - 1] ?? "")
      && !/[\w$]/.test(sqlText[index + 6] ?? "")) {
      return index + 6
    }
  }
  return null
}

/**
 * Add the database-side time limit to a statement's top-level SELECT. A WITH
 * statement gets it on the SELECT after its CTEs; EXPLAIN on the statement it
 * explains. SHOW and DESCRIBE have no SELECT and are returned unchanged.
 */
export function withDatabaseTimeLimit(sqlText: string, timeLimitMs: number): string {
  const ms = Math.max(1, Math.floor(timeLimitMs))
  const at = topLevelSelectEnd(sqlText)
  if (at === null) return sqlText
  const rest = sqlText.slice(at)
  const directive = ` /*vt+ QUERY_TIMEOUT_MS=${ms} */`
  // MySQL reads one hint comment per query block, so join one already there.
  const existingHint = /^\s*\/\*\+/.exec(rest)
  if (existingHint) {
    const hintStart = at + existingHint[0].length
    const hintClose = sqlText.indexOf("*/", hintStart)
    if (hintClose === -1) return sqlText
    return `${sqlText.slice(0, hintStart)} MAX_EXECUTION_TIME(${ms})${sqlText.slice(hintStart, hintClose + 2)}${directive}${sqlText.slice(hintClose + 2)}`
  }
  return `${sqlText.slice(0, at)} /*+ MAX_EXECUTION_TIME(${ms}) */${directive}${rest}`
}
