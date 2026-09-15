import { useState } from 'react'
import icons from './item-icons.json'
import ItemTooltip, { itemDisplayName, useInsideTooltip, type ItemTooltipData } from './ItemTooltip.tsx'
export function itemId(line: string): number { return Number(line.match(/(?:^|,)id=(\d+)/)?.[1] ?? 0) }

/** Every item icon supplies a fallback tooltip; explicit variant tooltips take precedence. */
export default function ItemIcon({ id, name, tooltip }: { id?: number; name?: string | null; tooltip?: Partial<ItemTooltipData> }): JSX.Element {
  const inside = useInsideTooltip()
  const icon = name ?? (id === undefined ? undefined : (icons as Record<string, string>)[id])
  const [failed, setFailed] = useState('')
  const content = icon && failed !== icon
    ? <img className="item-icon" src={`./item-icons/${icon}.jpg`} alt="" loading="lazy" onError={() => setFailed(icon)} />
    : <span className="item-icon icon-fallback" aria-hidden="true">◇</span>
  return inside ? content : <ItemTooltip data={{ id, name: itemDisplayName(id, name), ...tooltip }}>{content}</ItemTooltip>
}
