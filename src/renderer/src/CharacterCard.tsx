import { useEffect, useState } from 'react'
import type { SimItBoiApi } from '../../core/api.ts'

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi

/** The game's class colours, as the character sheet and armory show them. */
const CLASSES: Record<string, { name: string; color: string }> = {
  deathknight: { name: 'Death Knight', color: '#C41E3A' },
  demonhunter: { name: 'Demon Hunter', color: '#A330C9' },
  druid: { name: 'Druid', color: '#FF7C0A' },
  evoker: { name: 'Evoker', color: '#33937F' },
  hunter: { name: 'Hunter', color: '#AAD372' },
  mage: { name: 'Mage', color: '#3FC7EB' },
  monk: { name: 'Monk', color: '#00FF98' },
  paladin: { name: 'Paladin', color: '#F48CBA' },
  priest: { name: 'Priest', color: '#FFFFFF' },
  rogue: { name: 'Rogue', color: '#FFF468' },
  shaman: { name: 'Shaman', color: '#0070DD' },
  warlock: { name: 'Warlock', color: '#8788EE' },
  warrior: { name: 'Warrior', color: '#C69B6D' }
}

const titleCase = (token: string): string =>
  token.split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')

export interface CharacterCardProfile {
  characterName: string
  className: string
  spec?: string
  level?: number
  itemLevel: number | null
  header: { region?: string; realm?: string }
}

/** Portrait, spec and class in class colour, and item level for the imported character. */
export function CharacterCard({ profile }: { profile: CharacterCardProfile }): JSX.Element {
  const { characterName, className, spec, level, itemLevel, header } = profile
  const [portrait, setPortrait] = useState<string | null>(null)

  useEffect(() => {
    setPortrait(null)
    if (!header.region || !header.realm || !characterName) return
    let current = true
    void api.characterPortrait({ region: header.region, realm: header.realm, name: characterName })
      .then((r) => { if (current && r.ok) setPortrait(r.dataUrl) })
    return () => { current = false }
  }, [header.region, header.realm, characterName])

  const cls = CLASSES[className]
  const color = cls?.color ?? 'var(--fg)'
  const role = [spec ? titleCase(spec) : null, cls?.name ?? titleCase(className)].filter(Boolean).join(' ')

  return (
    <div className="character-card">
      <div className="character-portrait" style={{ borderColor: color }}>
        {portrait
          ? <img src={portrait} alt="" width={64} height={64} />
          : <span style={{ color }} aria-hidden="true">{characterName.slice(0, 1).toUpperCase()}</span>}
      </div>
      <div className="character-text">
        <h2>{characterName}</h2>
        <p className="character-role" style={{ color }}>{role}</p>
        <p className="character-meta">
          {level ? <span>Level {level}</span> : null}
          {header.realm ? <span>{header.region?.toUpperCase()}-{header.realm}</span> : null}
        </p>
      </div>
      {itemLevel !== null ? (
        <div className="character-ilvl" title={'Average equipped item level: ' + itemLevel.toFixed(2)}>
          <strong>{Math.floor(itemLevel)}</strong>
          <small>item level</small>
        </div>
      ) : null}
    </div>
  )
}
