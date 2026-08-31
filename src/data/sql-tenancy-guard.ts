// tenant-guard: exempt — this module IS the guard; its patterns are not queries.
//
// The tenancy + soft-delete query guard, in one pure module so that the two
// places it must agree with each other cannot drift:
//
// - **at runtime**, `TenantDb` (worker/tenancy-db.ts) refuses to execute a
//   statement that fails these rules, so a mistake is an error in the request
//   that made it rather than a silent cross-tenant read;
// - **in CI**, `scripts/check-queries.ts` scans every SQL string literal in
//   `worker/**` and `src/data/**` with the same rules, so a mistake is a red
//   build rather than a latent one.
//
// Column-scoped tenancy is filter discipline, and this file is the discipline
// made mechanical (docs/multi-tenant-design.md, "Decision reversal").
//
// ## The rules
//
// A statement that touches `nodes`, `link`, or `meta` must:
//
// 1. **Name its tenant** — contain `user_id` and the `:tenant` token that only
//    `TenantDb` can bind. (Skipped in `"single"` mode: the browser corpus is
//    one user per browser profile and has no `user_id` column.)
// 2. **Say what it means about tombstones** —
//    - `SELECT`/`UPDATE` on `nodes`/`link` needs a `deleted_at` predicate,
//    - `INSERT` on `nodes`/`link` needs `deleted_at` among its columns,
//    - `DELETE` from `nodes`/`link` is refused outright: nothing is
//      hard-deleted by the app.
//    `meta` has no `deleted_at` column and is exempt from this rule.
//
// ## The two escape hatches, both greppable
//
// - `-- includes-deleted: <reason>` inside the statement (or `// …` on a line
//   just above it) satisfies rule 2 for a read that genuinely wants tombstones
//   — replication, trash, audit. Rule 1 still applies. At runtime the
//   equivalent is `TenantDb.includingDeleted()`.
// - `-- tenant-exempt: <reason>` waives both rules for one statement. Use it
//   only where there is no tenant to name or no tombstone to respect, and say
//   why.
//
// A whole file opts out with `tenant-guard: exempt — <reason>` near the top
// (tests, which drive raw engines on purpose, and this file).

/** Which shape a file's statements are written for. */
export type GuardMode = "tenant" | "single"

export interface GuardOptions {
  mode: GuardMode
  /** `TenantDb.includingDeleted()` — waives the `deleted_at` rule. */
  includingDeleted?: boolean
}

export type GuardRule =
  | "missing-tenant-predicate"
  | "missing-deleted-at-predicate"
  | "missing-deleted-at-column"
  | "hard-delete"

const RULE_MESSAGE: Record<GuardRule, string> = {
  "missing-tenant-predicate":
    "statement touches a corpus table without `user_id` + `:tenant` — every corpus " +
    "statement must name its tenant (add the predicate, or `-- tenant-exempt: <reason>`)",
  "missing-deleted-at-predicate":
    "statement reads or updates nodes/link without a `deleted_at` predicate — say " +
    "whether tombstones are included (`deleted_at IS NULL`, `.includingDeleted()`, " +
    "or `-- includes-deleted: <reason>`)",
  "missing-deleted-at-column":
    "INSERT into nodes/link without a `deleted_at` column — a write must state the " +
    "row's tombstone state explicitly",
  "hard-delete":
    "DELETE from nodes/link — nothing is hard-deleted by the app; stamp `deleted_at` " +
    "instead (or `-- tenant-exempt: <reason>` for a genuine wipe/purge)",
}

/** The corpus tables the rules apply to. */
const CORPUS_TABLES = ["nodes", "link", "meta"] as const
type CorpusTable = (typeof CORPUS_TABLES)[number]

const TABLE_REFERENCE = /\b(?:FROM|INTO|JOIN|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi

const SQL_STATEMENT =
  /\b(SELECT|INSERT\s+INTO|INSERT\s+OR\s+REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|CREATE\s+INDEX|DROP\s+TABLE|ALTER\s+TABLE|PRAGMA)\b/i

const DDL = /^\s*(CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i

/** Does the text carry a `deleted_at` PREDICATE (not merely the column name)? */
const DELETED_AT_PREDICATE = /\bdeleted_at\s*(?:IS\s+(?:NOT\s+)?NULL|[<>=!])/i

const TENANT_TOKEN = /:tenant\b/
const USER_ID = /\buser_id\b/
const DELETED_AT = /\bdeleted_at\b/

const EXEMPT_ANNOTATION = /(?:--|\/\/|\*)\s*tenant-exempt:/i
const INCLUDES_DELETED_ANNOTATION = /(?:--|\/\/|\*)\s*includes-deleted:/i
/** File-level opt-out, e.g. in a test that drives a raw engine on purpose. */
const EXEMPT_FILE_ANNOTATION = /tenant-guard:\s*exempt\b/i

/** Is this string plausibly a SQL statement at all? */
function looksLikeSql(text: string): boolean {
  return SQL_STATEMENT.test(text)
}

/** Which corpus tables a statement touches. */
export function corpusTablesIn(sql: string): CorpusTable[] {
  const found = new Set<CorpusTable>()
  for (const match of sql.matchAll(TABLE_REFERENCE)) {
    const table = match[1].toLowerCase()
    if ((CORPUS_TABLES as readonly string[]).includes(table)) found.add(table as CorpusTable)
  }
  return [...found]
}

const statementKind = (sql: string): "select" | "insert" | "update" | "delete" | "other" => {
  const head = sql.trimStart()
  if (/^SELECT\b/i.test(head)) return "select"
  if (/^INSERT\b/i.test(head)) return "insert"
  if (/^UPDATE\b/i.test(head)) return "update"
  if (/^DELETE\b/i.test(head)) return "delete"
  return "other"
}

/**
 * Check one statement. Returns the rules it breaks (empty = compliant).
 * `annotations` is any comment text attached to the statement — its own SQL
 * comments plus nearby source comments; the caller decides what "nearby"
 * means.
 */
export function checkStatement(sql: string, options: GuardOptions, annotations = ""): GuardRule[] {
  const context = sql + "\n" + annotations
  if (EXEMPT_ANNOTATION.test(context)) return []
  if (DDL.test(sql)) return []

  const tables = corpusTablesIn(sql)
  if (tables.length === 0) return []

  const violations: GuardRule[] = []
  if (options.mode === "tenant" && !(USER_ID.test(sql) && TENANT_TOKEN.test(sql))) {
    violations.push("missing-tenant-predicate")
  }

  const touchesRows = tables.includes("nodes") || tables.includes("link")
  if (touchesRows) {
    const kind = statementKind(sql)
    if (kind === "delete") {
      violations.push("hard-delete")
    } else if (kind === "insert") {
      if (!DELETED_AT.test(sql)) violations.push("missing-deleted-at-column")
    } else if (kind === "select" || kind === "update") {
      const declared =
        options.includingDeleted === true || INCLUDES_DELETED_ANNOTATION.test(context)
      if (!declared && !DELETED_AT_PREDICATE.test(sql)) {
        violations.push("missing-deleted-at-predicate")
      }
    }
  }
  return violations
}

/** Human-readable explanation of a broken rule. */
export const explainRule = (rule: GuardRule): string => RULE_MESSAGE[rule]

// -----------------------------------------------------------------------------
// Source scanning (the CI half)
// -----------------------------------------------------------------------------

export interface SourceViolation {
  line: number
  rule: GuardRule | "env-db-outside-tenancy-module"
  statement: string
}

interface Literal {
  text: string
  start: number
  end: number
  line: number
}

interface Comment {
  text: string
  line: number
  /** Last line the comment covers — consecutive `//` lines are merged into
   * one block, so a two-line annotation counts as one annotation. */
  endLine: number
}

interface Scan {
  literals: Literal[]
  comments: Comment[]
  /** The source with comments and string bodies blanked, for coarse checks. */
  code: string
}

/**
 * One pass over TypeScript source, splitting it into string literals and
 * comments. Deliberately small: it understands `'`, `"`, backticks, `//`, and
 * `/* *\/`, which is everything the SQL in this repo lives inside. Regexes and
 * exotic syntax are not modelled — a false positive is a review conversation,
 * never a silent pass.
 */
export function scanSource(source: string): Scan {
  const literals: Literal[] = []
  const comments: Comment[] = []
  const code: string[] = []
  let line = 1
  let index = 0

  /** Comments and string bodies are blanked out of `code`, keeping offsets. */
  const blank = (char: string) => code.push(char === "\n" ? "\n" : " ")
  /** Is everything between the last newline and `at` whitespace? */
  const ownLine = (at: number) => {
    for (let i = at - 1; i >= 0 && source[i] !== "\n"; i -= 1) {
      if (!/\s/.test(source[i])) return false
    }
    return true
  }

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      const stop = end === -1 ? source.length : end
      const text = source.slice(index, stop)
      const previous = comments[comments.length - 1]
      // Merge a run of whole-line `//` comments into one block: a two-line
      // annotation is one annotation, and attaching it to a statement must not
      // depend on which of its lines happened to fall inside the window. A
      // comment trailing code starts a block of its own.
      if (
        previous &&
        previous.endLine === line - 1 &&
        previous.text.startsWith("//") &&
        ownLine(index)
      ) {
        previous.text += "\n" + text
        previous.endLine = line
      } else {
        comments.push({ text, line, endLine: line })
      }
      for (; index < stop; index += 1) blank(source[index])
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      const stop = end === -1 ? source.length : end + 2
      const text = source.slice(index, stop)
      const startLine = line
      for (; index < stop; index += 1) {
        if (source[index] === "\n") line += 1
        blank(source[index])
      }
      comments.push({ text, line: startLine, endLine: line })
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char
      const startLine = line
      const start = index
      index += 1
      let text = ""
      while (index < source.length) {
        const inner = source[index]
        if (inner === "\\") {
          text += source.slice(index, index + 2)
          index += 2
          continue
        }
        if (inner === quote) {
          index += 1
          break
        }
        if (inner === "\n") line += 1
        text += inner
        index += 1
      }
      literals.push({ text, start, end: index, line: startLine })
      code.push(" ")
      continue
    }
    if (char === "\n") line += 1
    code.push(char)
    index += 1
  }

  return { literals, comments, code: code.join("") }
}

/** Merge literals joined only by `+` into one logical statement. */
function mergeConcatenations(source: string, literals: Literal[]): Literal[] {
  const merged: Literal[] = []
  for (const literal of literals) {
    const previous = merged[merged.length - 1]
    if (previous && /^\s*\+\s*$/.test(source.slice(previous.end, literal.start))) {
      previous.text += literal.text
      previous.end = literal.end
      continue
    }
    merged.push({ ...literal })
  }
  return merged
}

/** Unescape the escapes the scanner kept verbatim, so `\n` reads as a break. */
const unescape = (text: string) => text.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1")

export interface CheckSourceOptions {
  mode: GuardMode
  /** Only the tenancy module may reach for the raw D1 binding. */
  allowEnvDb?: boolean
}

/**
 * Check one source file's SQL string literals. Returns every violation with
 * its line, or an empty array. A file opting out with `tenant-guard: exempt`
 * near the top is skipped entirely.
 */
export function checkSource(source: string, options: CheckSourceOptions): SourceViolation[] {
  const scan = scanSource(source)
  const header = source.split("\n").slice(0, 60).join("\n")
  if (EXEMPT_FILE_ANNOTATION.test(header)) return []

  const violations: SourceViolation[] = []

  if (options.allowEnvDb !== true) {
    const envDb = /\benv\s*\.\s*DB\b/g
    for (const match of scan.code.matchAll(envDb)) {
      violations.push({
        line: scan.code.slice(0, match.index).split("\n").length,
        rule: "env-db-outside-tenancy-module",
        statement: "env.DB",
      })
    }
  }

  for (const literal of mergeConcatenations(source, scan.literals)) {
    const sql = unescape(literal.text)
    if (!looksLikeSql(sql)) continue
    // A comment block counts as attached when it ENDS within three lines above
    // the statement (or sits on the same line).
    const nearby = scan.comments
      .filter((comment) => comment.endLine >= literal.line - 3 && comment.line <= literal.line)
      .map((comment) => comment.text)
      .join("\n")
    for (const rule of checkStatement(sql, { mode: options.mode }, nearby)) {
      violations.push({ line: literal.line, rule, statement: sql.trim().slice(0, 120) })
    }
  }

  return violations
}
