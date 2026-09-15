import { Store } from '../src/core/store/db.ts'
const path = process.argv[2] ?? 'data/ui-test/simitboi.db'
const s = new Store(path)
console.log(`db: ${path}`)
console.log(`schema v${s.schemaVersion} · ${s.countReports()} reports · ${s.listProfiles().length} profiles`)
for (const r of s.listReports()) {
  const d = r.delta !== null && r.delta !== 0 ? ` delta=${Math.round(r.delta)}` : ''
  console.log(`  ${r.kind.padEnd(8)} ${String(r.characterName).padEnd(13)} dps=${r.dps ? Math.round(r.dps) : '—'}${d} simc=${r.simcBuild} sum=${r.profileChecksum}`)
}
for (const p of s.listProfiles()) {
  console.log(`  profile ${p.checksum} ${p.characterName} ${p.className}/${p.spec} ${p.region}/${p.realm}`)
}
const first = s.listReports()[0]
if (first) {
  const full = s.getReport(first.id)
  console.log(`payload of newest (${first.kind}): ${JSON.stringify(full?.payload).length.toLocaleString()} bytes`)
}
s.close()
