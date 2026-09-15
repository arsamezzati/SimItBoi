/**
 * CSV parsing for the DB2 exports.
 *
 * Splitting a CSV line on commas is wrong the moment a field contains one, and
 * these fields do: `1298085,"Jan'thrazet, the Soul Fang"` split on commas gives
 * `Jan'thrazet` and the rest is thrown away. `build-season-gear.ts` did exactly
 * that and shipped two truncated effect names. `build-db2.ts` had a correct
 * parser all along, which is now here so there is one implementation rather
 * than one correct and one not.
 *
 * Handles quoted fields, escaped quotes (`""`), embedded newlines and CRLF.
 */

export type Row = Record<string, string>

/** Splits a CSV document into rows of raw fields. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Parses a CSV into objects keyed by its header row.
 *
 * `required` names columns the caller depends on. A DB2 export that renamed or
 * dropped a column would otherwise produce rows full of `undefined` that read
 * as "this item has no effect" rather than as an error — the same class of
 * silent wrongness as the comma bug, one level up.
 */
export function parseCsv(text: string, required: readonly string[] = []): Row[] {
  const rows = parseCsvRows(text)
  const head = rows.shift()
  if (!head) throw new Error('Empty CSV')

  const missing = required.filter((column) => !head.includes(column))
  if (missing.length > 0) {
    throw new Error('CSV is missing expected columns: ' + missing.join(', ') + '. Header: ' + head.join(','))
  }

  return rows
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(r.map((v, i) => [head[i]!, v])))
}

/**
 * Indexes a CSV by one column, keeping a chosen field from each row.
 *
 * The shape `build-season-gear.ts` needs everywhere: "spell id to spell name",
 * "file id to icon name". Written once so each of those joins cannot reintroduce
 * its own splitter.
 */
export function csvMap(
  text: string,
  keyColumn: string,
  valueColumn: string
): Map<string, string> {
  const result = new Map<string, string>()
  for (const row of parseCsv(text, [keyColumn, valueColumn])) {
    const key = row[keyColumn]
    if (key) result.set(key, row[valueColumn] ?? '')
  }
  return result
}
