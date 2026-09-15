/**
 * SQLite persistence.
 *
 * Uses Node's built-in `node:sqlite` rather than better-sqlite3: no native
 * module, no C++ toolchain, and nothing to rebuild at package time.
 *
 * Everything lives in one file under the portable data directory, so
 * deleting the app folder still removes all state.
 */
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

/**
 * Migrations are append-only and run in order. Each entry's index+1 is the
 * schema version it produces, so a database at version N skips the first N.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE reports (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    character_name   TEXT,
    class_name       TEXT,
    spec             TEXT,
    dps              REAL,
    delta            REAL,
    simc_build       TEXT,
    duration_ms      INTEGER,
    profile_checksum TEXT,
    label            TEXT,
    payload          TEXT NOT NULL
  );
  CREATE INDEX idx_reports_created ON reports (created_at DESC);
  CREATE INDEX idx_reports_kind    ON reports (kind, created_at DESC);

  CREATE TABLE profiles (
    checksum       TEXT PRIMARY KEY,
    character_name TEXT,
    class_name     TEXT,
    spec           TEXT,
    realm          TEXT,
    region         TEXT,
    raw            TEXT NOT NULL,
    first_seen     INTEGER NOT NULL,
    last_used      INTEGER NOT NULL
  );
  CREATE INDEX idx_profiles_used ON profiles (last_used DESC);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `
]

export type ReportKind = 'quick' | 'topgear' | 'loadouts'

export interface ReportRow {
  id: string
  kind: ReportKind
  createdAt: number
  characterName: string | null
  className: string | null
  spec: string | null
  dps: number | null
  delta: number | null
  simcBuild: string | null
  durationMs: number | null
  profileChecksum: string | null
  label: string | null
}

export interface ProfileRow {
  checksum: string
  characterName: string | null
  className: string | null
  spec: string | null
  realm: string | null
  region: string | null
  firstSeen: number
  lastUsed: number
}

interface RawReportRow {
  id: string
  kind: string
  created_at: number
  character_name: string | null
  class_name: string | null
  spec: string | null
  dps: number | null
  delta: number | null
  simc_build: string | null
  duration_ms: number | null
  profile_checksum: string | null
  label: string | null
  payload?: string
}

interface RawProfileRow {
  checksum: string
  character_name: string | null
  class_name: string | null
  spec: string | null
  realm: string | null
  region: string | null
  raw?: string
  first_seen: number
  last_used: number
}

function toReportRow(r: RawReportRow): ReportRow {
  return {
    id: r.id,
    kind: r.kind as ReportKind,
    createdAt: r.created_at,
    characterName: r.character_name,
    className: r.class_name,
    spec: r.spec,
    dps: r.dps,
    delta: r.delta,
    simcBuild: r.simc_build,
    durationMs: r.duration_ms,
    profileChecksum: r.profile_checksum,
    label: r.label
  }
}

function toProfileRow(r: RawProfileRow): ProfileRow {
  return {
    checksum: r.checksum,
    characterName: r.character_name,
    className: r.class_name,
    spec: r.spec,
    realm: r.realm,
    region: r.region,
    firstSeen: r.first_seen,
    lastUsed: r.last_used
  }
}

export interface SaveReportInput {
  id: string
  kind: ReportKind
  createdAt?: number
  characterName?: string | null
  className?: string | null
  spec?: string | null
  dps?: number | null
  delta?: number | null
  simcBuild?: string | null
  durationMs?: number | null
  profileChecksum?: string | null
  label?: string | null
  payload: unknown
}

export interface SaveProfileInput {
  checksum: string
  raw: string
  characterName?: string | null
  className?: string | null
  spec?: string | null
  realm?: string | null
  region?: string | null
}

export class Store {
  private readonly db: DatabaseSync

  /** `:memory:` is accepted, which is what the tests use. */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined
    let current = row?.version ?? 0
    if (row === undefined) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(0)
    }
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i])
      current = i + 1
    }
    this.db.prepare('UPDATE schema_version SET version = ?').run(current)
  }

  get schemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined
    return row?.version ?? 0
  }

  // --- Reports -------------------------------------------------------------

  saveReport(input: SaveReportInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reports
         (id, kind, created_at, character_name, class_name, spec, dps, delta,
          simc_build, duration_ms, profile_checksum, label, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.kind,
        input.createdAt ?? Date.now(),
        input.characterName ?? null,
        input.className ?? null,
        input.spec ?? null,
        input.dps ?? null,
        input.delta ?? null,
        input.simcBuild ?? null,
        input.durationMs ?? null,
        input.profileChecksum ?? null,
        input.label ?? null,
        JSON.stringify(input.payload)
      )
  }

  listReports(opts: { kind?: ReportKind; limit?: number; offset?: number } = {}): ReportRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    const offset = Math.max(opts.offset ?? 0, 0)
    const sql = opts.kind
      ? `SELECT id, kind, created_at, character_name, class_name, spec, dps, delta,
                simc_build, duration_ms, profile_checksum, label
           FROM reports WHERE kind = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT id, kind, created_at, character_name, class_name, spec, dps, delta,
                simc_build, duration_ms, profile_checksum, label
           FROM reports ORDER BY created_at DESC LIMIT ? OFFSET ?`
    const stmt = this.db.prepare(sql)
    const rows = (
      opts.kind ? stmt.all(opts.kind, limit, offset) : stmt.all(limit, offset)
    ) as unknown as RawReportRow[]
    return rows.map(toReportRow)
  }

  /** Returns the stored payload, or undefined if the id is unknown. */
  getReport<T = unknown>(id: string): { row: ReportRow; payload: T } | undefined {
    const r = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as
      | RawReportRow
      | undefined
    if (!r) return undefined
    return { row: toReportRow(r), payload: JSON.parse(r.payload ?? 'null') as T }
  }

  deleteReport(id: string): boolean {
    const info = this.db.prepare('DELETE FROM reports WHERE id = ?').run(id)
    return Number(info.changes) > 0
  }

  countReports(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }
    return Number(r.n)
  }

  /** Keeps the newest `keep` reports and deletes the rest. Returns rows removed. */
  pruneReports(keep: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM reports WHERE id NOT IN (
           SELECT id FROM reports ORDER BY created_at DESC LIMIT ?
         )`
      )
      .run(Math.max(keep, 0))
    return Number(info.changes)
  }

  // --- Profiles ------------------------------------------------------------

  /**
   * Upserts a profile keyed by the addon export's own checksum, so
   * re-pasting an unchanged export updates `last_used` rather than duplicating.
   */
  saveProfile(input: SaveProfileInput): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO profiles
           (checksum, character_name, class_name, spec, realm, region, raw, first_seen, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checksum) DO UPDATE SET
           last_used = excluded.last_used,
           raw = excluded.raw,
           character_name = excluded.character_name,
           class_name = excluded.class_name,
           spec = excluded.spec,
           realm = excluded.realm,
           region = excluded.region`
      )
      .run(
        input.checksum,
        input.characterName ?? null,
        input.className ?? null,
        input.spec ?? null,
        input.realm ?? null,
        input.region ?? null,
        input.raw,
        now,
        now
      )
  }

  listProfiles(limit = 25): ProfileRow[] {
    const rows = this.db
      .prepare(
        `SELECT checksum, character_name, class_name, spec, realm, region, first_seen, last_used
           FROM profiles ORDER BY last_used DESC LIMIT ?`
      )
      .all(Math.min(Math.max(limit, 1), 200)) as unknown as RawProfileRow[]
    return rows.map(toProfileRow)
  }

  getProfile(checksum: string): { row: ProfileRow; raw: string } | undefined {
    const r = this.db.prepare('SELECT * FROM profiles WHERE checksum = ?').get(checksum) as
      | RawProfileRow
      | undefined
    if (!r) return undefined
    return { row: toProfileRow(r), raw: r.raw ?? '' }
  }

  deleteProfile(checksum: string): boolean {
    const info = this.db.prepare('DELETE FROM profiles WHERE checksum = ?').run(checksum)
    return Number(info.changes) > 0
  }

  // --- Settings ------------------------------------------------------------

  getSetting(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return r?.value
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}
