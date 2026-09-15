import type { ProfileHeader } from './types.ts'
import type { SimReport } from './report/extract.ts'
import type { SimProgress, SimcVersion } from './simc/runner.ts'
import type { CandidateOption, TopGearOptions, TopGearProgress, TopGearResult } from './topgear/funnel.ts'
import type { ProfileRow, ReportKind, ReportRow } from './store/db.ts'
import type { LoadoutComparison } from './topgear/loadouts.ts'
import type { TableCoverage } from './data/itemTable.ts'
import type { CatalogSelection, searchCatalog } from './data/catalog.ts'
import type { Embellishment, Gem, Enchant } from './data/db2.ts'
import type { CraftedRecipe, CraftedSelection } from './data/crafted.ts'

/** A craftable recipe plus its gem sockets, as the picker needs it. */
/**
 * A recipe plus the embellishment bonus ids that are legal on *this* recipe.
 * The renderer must not re-derive that: equipment slot alone cannot express
 * expansion, armor class or profession.
 */
export type CraftedOption = CraftedRecipe & { sockets: number; embellishmentBonusIds: number[] }
/** An embellishment plus the equipment slots it may legally go on. */
export type EmbellishmentOption = Embellishment & { slots: string[] }
import type { HypotheticalInput } from './topgear/hypothetical.ts'
import type { ItemStatState } from './data/itemStats.ts'
import type { ItemPreviewRequest } from './data/itemPreview.ts'
import type { InstallResult, UpdateCheck, UpdateProgress } from './simc/update.ts'

/** One provisioned simc build, with whatever is wrong with it. */
export interface SimcBuildSummary {
  buildId: string
  version: string | null
  source: string
  provisionedAt: string
  active: boolean
  /** Empty when the build's files all match their recorded checksums. */
  problems: string[]
}

type Response<T> = ({ ok: true } & T) | { ok: false; error: string }
export interface ParsedProfileSummary {
  characterName: string; className: string; spec?: string; level?: number; race?: string
  header: ProfileHeader; checksum?: string; savedLoadouts: string[]; equippedCount: number
  bagCount: number; extraLines: string[]; warnings: string[]; candidates: CandidateOption[]
  /** How well the bundled item table covers this profile. */
  coverage: TableCoverage
}
export interface SimItBoiApi {
  itemPreview(raw: string, request: ItemPreviewRequest, cancel?: boolean): Promise<Response<{ state: ItemStatState; note?: string }>>
  searchItems(raw: string, query: string, slot?: string): Promise<Response<ReturnType<typeof searchCatalog>>>
  configureItem(raw: string, selection: CatalogSelection): Promise<Response<{ item: HypotheticalInput }>>
  /** Craftable recipes this character can use. */
  craftableItems(raw: string, query: string, slot?: string): Promise<Response<{
    items: CraftedOption[]; total: number; stats: Array<{ id: number; name: string }>
  }>>
  configureCrafted(raw: string, selection: CraftedSelection): Promise<Response<{ item: HypotheticalInput }>>
  /** Embellishment, gem and enchant lists from the DB2 table. */
  gearOptions(): Promise<Response<{
    embellishments: EmbellishmentOption[]; gems: Gem[]; enchants: Enchant[]; embellishmentLimit: number
  }>>
  envInfo(): Promise<Record<string, unknown>>
  simcVersion(): Promise<Response<{ version: SimcVersion | null }>>
  /** Provisioned simc builds and their verification state. */
  simcBuilds(): Promise<Response<{ builds: SimcBuildSummary[]; previousBuildId: string | null; problem: string | null }>>
  activateSimcBuild(buildId: string): Promise<Response<{ buildId: string }>>
  rollbackSimcBuild(): Promise<Response<{ buildId: string }>>
  /** Asks whether a newer approved simc exists; `force` skips the cached answer. */
  checkSimcUpdate(force?: boolean): Promise<Response<{ check: UpdateCheck }>>
  /** Installs the build the last check found. The renderer never names one. */
  installSimcUpdate(): Promise<Response<{ result: InstallResult }>>
  onSimcUpdateProgress(cb: (progress: UpdateProgress) => void): () => void
  parseProfile(raw: string): Promise<Response<{ profile: ParsedProfileSummary }>>
  runSim(raw: string, opts?: { iterations?: number }): Promise<Response<{
    report: SimReport; durationMs: number; simcVersion: string | null
    versionWarning: string | null; reportId: string
  }>>
  runTopGear(raw: string, opts: TopGearOptions): Promise<Response<{ result: TopGearResult; reportId: string }>>
  /** Compares every distinct saved talent loadout in one profileset batch. */
  runLoadouts(raw: string, opts?: { threads?: number; fightSeconds?: number }):
    Promise<Response<{ comparison: LoadoutComparison; reportId: string }>>
  /** Report history. Survives restarts; capped at 200 newest. */
  listHistory(opts?: { kind?: ReportKind; limit?: number; offset?: number }):
    Promise<Response<{ reports: ReportRow[]; total: number }>>
  getHistory(id: string): Promise<Response<{ row: ReportRow; payload: unknown }>>
  deleteHistory(id: string): Promise<Response<{ deleted: boolean }>>
  listProfiles(): Promise<Response<{ profiles: ProfileRow[] }>>
  getProfile(checksum: string): Promise<Response<{ row: ProfileRow; raw: string }>>
  rememberProfile(raw: string): Promise<Response<{ checksum: string }>>
  /** Real hover stats keyed by exact ordered tokens plus requested placement. */
  itemStats(raw: string): Promise<Response<{ stats: Record<string, ItemStatState> }>>
  cancelItemStats(raw: string): Promise<{ ok: boolean }>
  cancelSim(): Promise<{ ok: boolean }>
  onProgress(cb: (p: SimProgress) => void): () => void
  onTopGearProgress(cb: (p: TopGearProgress) => void): () => void
}
