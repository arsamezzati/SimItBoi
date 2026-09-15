import { useEffect, useState } from 'react'
import type { ArmoryStatus, SimItBoiApi } from '../../core/api.ts'
import type { ArmoryRegion } from '../../core/armory/blizzard.ts'

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi

const REGIONS: Array<{ value: ArmoryRegion; label: string }> = [
  { value: 'eu', label: 'Europe' }, { value: 'us', label: 'Americas & Oceania' },
  { value: 'kr', label: 'Korea' }, { value: 'tw', label: 'Taiwan' }
]
const LAST_LOOKUP = 'armory-last-lookup'

function remembered(): { region: ArmoryRegion; realm: string; name: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_LOOKUP) ?? 'null') as { region?: ArmoryRegion; realm?: string; name?: string } | null
    return { region: saved?.region ?? 'eu', realm: saved?.realm ?? '', name: saved?.name ?? '' }
  } catch {
    return { region: 'eu', realm: '', name: '' }
  }
}

/** Looks a character up on the Blizzard armory and hands back an addon-format profile. */
export function ArmoryImport({ disabled, onImported }: { disabled: boolean; onImported: (raw: string) => void }): JSX.Element {
  const [lookup, setLookup] = useState(remembered)
  const [status, setStatus] = useState<ArmoryStatus | null>(null)
  const [realms, setRealms] = useState<Array<{ name: string; slug: string }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keyMessage, setKeyMessage] = useState<string | null>(null)

  useEffect(() => { void api.armoryStatus().then(setStatus) }, [])

  // Realm suggestions for the chosen region, once lookups are possible.
  useEffect(() => {
    if (!status || status.source === 'none') return
    let current = true
    setRealms([])
    void api.armoryRealms(lookup.region).then((r) => { if (current && r.ok) setRealms(r.realms) })
    return () => { current = false }
  }, [lookup.region, status])

  async function search(): Promise<void> {
    setBusy(true)
    setError(null)
    setImported(null)
    try {
      const r = await api.importArmory(lookup)
      if (!r.ok) { setError(r.error); return }
      try { localStorage.setItem(LAST_LOOKUP, JSON.stringify(lookup)) } catch { /* only a convenience */ }
      setImported(r.lastLogin ? 'Gear as of last logout, ' + new Date(r.lastLogin).toLocaleString() + '.' : null)
      onImported(r.raw)
    } finally {
      setBusy(false)
    }
  }

  async function saveKey(remove: boolean): Promise<void> {
    setSavingKey(true)
    setKeyMessage(null)
    try {
      const r = await api.setArmoryCredentials(remove ? null : { clientId, clientSecret })
      if (!r.ok) { setKeyMessage(r.error); return }
      setStatus(r.status)
      setClientId('')
      setClientSecret('')
      setKeyMessage(remove ? 'Your API client was removed.' : 'Saved. Armory search now uses your API client.')
    } finally {
      setSavingKey(false)
    }
  }

  const unavailable = status?.source === 'none'
  const canSearch = !disabled && !busy && !unavailable && lookup.realm.trim() !== '' && lookup.name.trim() !== ''

  return (
    <div className="armory-import">
      <form className="armory-form" onSubmit={(e) => { e.preventDefault(); if (canSearch) void search() }}>
        <label>Region
          <select value={lookup.region} disabled={disabled || busy}
            onChange={(e) => setLookup({ ...lookup, region: e.target.value as ArmoryRegion })}>
            {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
        <label>Realm
          <input list="armory-realms" value={lookup.realm} disabled={disabled || busy} placeholder="Draenor"
            autoComplete="off" spellCheck={false}
            onChange={(e) => setLookup({ ...lookup, realm: e.target.value })} />
          <datalist id="armory-realms">{realms.map((r) => <option key={r.slug} value={r.name} />)}</datalist>
        </label>
        <label>Character
          <input value={lookup.name} disabled={disabled || busy} placeholder="Name" autoComplete="off" spellCheck={false}
            onChange={(e) => setLookup({ ...lookup, name: e.target.value })} />
        </label>
        <button type="submit" disabled={!canSearch}>{busy ? 'Searching…' : 'Import'}</button>
      </form>
      {error ? <p className="err">{error}</p> : null}
      {imported ? <p className="note">{imported}</p> : null}
      <p className="note">
        The armory has equipped gear and talents only. For bag items in Top Gear and named loadouts, paste a SimC addon string instead.
      </p>

      <details className="armory-key" open={unavailable}>
        <summary>{status?.source === 'own' ? 'Using your own Blizzard API client' : 'Use your own Blizzard API client'}</summary>
        <p className="note">
          {unavailable
            ? 'This copy of SimItBoi has no Blizzard API client built in. '
            : 'Optional. '}
          Create a free client at develop.battle.net (API Access), then enter its ID and secret. They are stored encrypted for your Windows account only.
        </p>
        <div className="armory-form">
          <label>Client ID
            <input value={clientId} disabled={savingKey} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label>Client secret
            <input type="password" value={clientSecret} disabled={savingKey} autoComplete="off" onChange={(e) => setClientSecret(e.target.value)} />
          </label>
          <button type="button" className="ghost" disabled={savingKey || !clientId.trim() || !clientSecret.trim()} onClick={() => void saveKey(false)}>
            {savingKey ? 'Checking…' : 'Save'}
          </button>
          {status?.source === 'own' ? (
            <button type="button" className="link danger" disabled={savingKey} onClick={() => void saveKey(true)}>Remove</button>
          ) : null}
        </div>
        {keyMessage ? <p className="note">{keyMessage}</p> : null}
      </details>
    </div>
  )
}
