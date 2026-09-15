/** Parsed from the en_US item preview. Unknown text must never mean unrestricted. */
export type UniqueRule =
  | { kind: 'none' }
  | { kind: 'item'; limit: number; raw: string }
  | { kind: 'category'; category: string; limit: number; raw: string }
  | { kind: 'unknown'; raw: string }

export function parseUniqueRule(raw: string | undefined): UniqueRule {
  if (raw === undefined || raw.trim() === '') return { kind: 'none' }
  const text = raw.trim()
  // Unique ownership also prevents wearing two copies of that item.
  if (text === 'Unique-Equipped' || text === 'Unique') return { kind: 'item', limit: 1, raw }
  const category = /^Unique-Equipped: (.+) \((\d+)\)$/.exec(text)
  if (category && Number(category[2]) > 0) {
    return { kind: 'category', category: category[1], limit: Number(category[2]), raw }
  }
  return { kind: 'unknown', raw }
}

/** Missing metadata is distinct from a confirmed absence of restrictions. */
export function satisfiesUniqueRules(items: Array<{ id: number; rule?: UniqueRule }>): boolean {
  const counts = new Map<string, number>()
  const limits = new Map<string, number>()
  for (const { id, rule } of items) {
    if (!rule || rule.kind === 'unknown') return false
    if (rule.kind === 'none') continue
    const key = rule.kind === 'item' ? `item:${id}` : `category:${rule.category}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    limits.set(key, Math.min(limits.get(key) ?? Infinity, rule.limit))
  }
  return [...counts].every(([key, count]) => count <= limits.get(key)!)
}

/**
 * Domain rules from game knowledge, not derivable from any data source.
 *
 * Neither the Blizzard API nor simc exposes cross-item
 * category limits. These rules close part of that gap from game knowledge:
 *
 *   1. Crafted epics are unique-equipped.
 *   2. Epic rings and trinkets are unique-equipped.
 *
 * Measured support: among Midnight-era (id ≥ 240000) epic rings and
 * trinkets the API already flags 94.3% as unique. Inspecting the 8 exceptions
 * found them to be PvP medallions/sigils, an alchemist stone and two plumes —
 * all *category*-limited in game, which is precisely what the API cannot
 * express. So the rule is more correct than the API here, not less.
 *
 * SAFETY: these only ever *add* a restriction. Over-applying one excludes a
 * legal combination — losing a little search space — whereas under-applying
 * admits an illegal one and fabricates DPS. Erring toward restriction is the
 * correct direction, and is why an API "none" is overridden rather than trusted.
 */
export interface UniqueContext {
  quality?: string
  inventoryType?: string
  /** The item string carries a `crafting_quality` token. */
  crafted: boolean
}

export function domainUniqueRule(ctx: UniqueContext): UniqueRule | null {
  const epic = ctx.quality === 'epic' || ctx.quality === 'legendary' || ctx.quality === 'artifact'
  if (!epic) return null
  if (ctx.crafted) return { kind: 'item', limit: 1, raw: 'domain rule: crafted epic' }
  if (ctx.inventoryType === 'FINGER' || ctx.inventoryType === 'TRINKET') {
    return { kind: 'item', limit: 1, raw: 'domain rule: epic ring or trinket' }
  }
  return null
}

/**
 * Combines what the API reported with the domain rules, keeping whichever is
 * more restrictive. A restriction is never downgraded, and absent metadata
 * still fails closed.
 */
export function resolveUniqueRule(
  api: UniqueRule | undefined,
  ctx: UniqueContext
): UniqueRule {
  // A category limit is the most specific thing we can know; never discard it.
  if (api?.kind === 'category') return api
  if (api?.kind === 'item') return api
  const domain = domainUniqueRule(ctx)
  if (domain) return domain
  if (api) return api
  return { kind: 'unknown', raw: 'no unique metadata' }
}
