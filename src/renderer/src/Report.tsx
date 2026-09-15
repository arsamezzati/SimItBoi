import type { SimReport } from '../../core/report/extract.ts'
import ItemIcon from './ItemIcon.tsx'
import ItemTooltip, { EquippedItems } from './ItemTooltip.tsx'

const fmt = (n: number): string => Math.round(n).toLocaleString()

export default function Report({
  report,
  durationMs,
  simcVersion,
  versionWarning
}: {
  report: SimReport
  durationMs: number
  simcVersion: string | null
  versionWarning: string | null
}): JSX.Element {
  const { dps, abilities, buffs, gear } = report

  return (
    <EquippedItems.Provider value={gear.map(g => g.id ?? 0)}><div className="report">
      {versionWarning ? <p className="warn banner">{versionWarning}</p> : null}

      <div className="headline">
        <div>
          <div className="dps">{fmt(dps.mean)}</div>
          <div className="sub">
            DPS ± {fmt(dps.error)} ({dps.errorPct.toFixed(2)}%)
          </div>
        </div>
        <dl className="facts">
          <Fact k="Range" v={`${fmt(dps.min)} – ${fmt(dps.max)}`} />
          <Fact k="Median" v={fmt(dps.median)} />
          <Fact k="Fight" v={`${report.fightLength.toFixed(0)}s`} />
          <Fact k="Iterations" v={report.iterations.toLocaleString()} />
          <Fact k="Wall time" v={`${(durationMs / 1000).toFixed(2)}s`} />
          <Fact k="simc" v={simcVersion ?? '—'} />
        </dl>
      </div>

      <section>
        <h3>
          Damage breakdown <small>{fmt(report.totalDamage)} total</small>
        </h3>
        <table className="bars">
          <tbody>
            {abilities.map((a) => (
              <tr key={a.name}>
                <th>{a.name}</th>
                <td className="num">{(a.share * 100).toFixed(1)}%</td>
                <td className="track">
                  <div className="bar-fill" style={{ width: `${a.share * 100}%` }} />
                </td>
                <td className="num dim">{fmt(a.executes)}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="two-col">
        <section>
          <h3>Buff uptimes</h3>
          <table className="bars">
            <tbody>
              {buffs.slice(0, 12).map((b) => (
                <tr key={b.name}>
                  <th>{b.name}</th>
                  <td className="num">{b.uptime.toFixed(1)}%</td>
                  <td className="track">
                    <div className="bar-fill alt" style={{ width: `${Math.min(b.uptime, 100)}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>
            Gear <small>{gear.length} slots</small>
          </h3>
          <table className="gear">
            <tbody>
              {gear.map((g) => (
                <tr key={g.slot}>
                  <th>{g.slot}</th>
                  <td>
                    <ItemTooltip data={{ id: g.id, name: g.name, ilvl: g.ilvl, slot: g.slot, stats: g.stats, itemString: g.encoded }}>
                      <span className="item-cell" tabIndex={0}><ItemIcon id={g.id ?? 0} /> {g.name}</span>
                    </ItemTooltip>
                  </td>
                  <td className="num">{g.ilvl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div></EquippedItems.Provider>
  )
}

function Fact({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="fact">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}
