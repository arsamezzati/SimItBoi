// Offline ID -> FileDataID -> icon name joins; download only missing bundled art.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
const read = p => JSON.parse(readFileSync(p, 'utf8'))
const db = read('src/core/data/db2.json')
const cache = `.cache/db2/${db.build}`
function* rows(text) {
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); yield row; row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); yield row }
}
const ids = new Set(db.craftedItems.map(i => i.itemId))
const wanted = new Map()
let header
for (const row of rows(readFileSync(`${cache}/Item.csv`, 'utf8'))) {
  if (!header) { header = row; continue }
  if (ids.has(Number(row[header.indexOf('ID')]))) wanted.set(row[header.indexOf('ID')], row[header.indexOf('IconFileDataID')])
}
const names = new Map()
header = undefined
for (const row of rows(readFileSync(`${cache}/ManifestInterfaceData.csv`, 'utf8'))) {
  if (!header) { header = row; continue }
  if (/^interface\\icons\\$/i.test(row[header.indexOf('FilePath')])) {
    names.set(row[header.indexOf('ID')], row[header.indexOf('FileName')].replace(/\.blp$/i, '').toLowerCase())
  }
}
const mappingPath = 'src/renderer/src/item-icons.json'
const mapping = read(mappingPath)
const dir = 'src/renderer/public/item-icons'
mkdirSync(dir, { recursive: true })
let downloaded = 0
const missing = []
let token
if (process.env.BLIZZARD_CLIENT_ID && process.env.BLIZZARD_CLIENT_SECRET) {
  const auth = await fetch('https://oauth.battle.net/token', { method: 'POST', headers: {
    Authorization: `Basic ${Buffer.from(`${process.env.BLIZZARD_CLIENT_ID}:${process.env.BLIZZARD_CLIENT_SECRET}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!auth.ok) throw new Error(`Icon authentication failed: ${auth.status}`)
  token = (await auth.json()).access_token
}
for (const id of ids) if (!wanted.has(String(id))) wanted.set(String(id), '0')
for (const [id, fileId] of wanted) {
  let name = names.get(fileId) ?? mapping[id]
  let assetUrl
  // Many crafted items have IconFileDataID=0; Blizzard's media endpoint resolves their appearance.
  if (!name && token) {
    const region = process.env.BLIZZARD_REGION ?? 'eu'
    const media = await fetch(`https://${region}.api.blizzard.com/data/wow/media/item/${id}?namespace=static-${region}&locale=en_US`, { headers: { Authorization: `Bearer ${token}` } })
    if (media.ok) {
      assetUrl = (await media.json()).assets?.find(a => a.key === 'icon')?.value
      if (assetUrl) name = new URL(assetUrl).pathname.split('/').at(-1).replace(/\.jpg$/i, '').toLowerCase()
    }
  }
  if (!name || !/^[a-z0-9_ -]+$/.test(name)) { missing.push(id); continue }
  const path = `${dir}/${name}.jpg`
  if (!existsSync(path)) {
    const response = await fetch(assetUrl ?? `https://wow.zamimg.com/images/wow/icons/large/${encodeURIComponent(name)}.jpg`)
    if (!response.ok) { missing.push(id); continue }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`Invalid JPEG for ${id}`)
    writeFileSync(path, bytes); downloaded++
  }
  mapping[id] = name
}
writeFileSync(mappingPath, JSON.stringify(mapping))
console.log(`Crafted icons: ${wanted.size - missing.length}/${wanted.size} mapped; ${downloaded} downloaded; missing: ${missing.join(', ') || 'none'}`)
