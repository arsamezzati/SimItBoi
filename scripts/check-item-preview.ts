import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
import type { SimItBoiApi } from '../src/core/api.ts'
const require = createRequire(import.meta.url)
const env=Object.fromEntries(Object.entries(process.env).filter(([k,v])=>k!=='ELECTRON_RUN_AS_NODE'&&v!==undefined)) as Record<string,string>
env.SIMITBOI_DEV_DATA_DIR=resolve('data/ui-preview-test'); delete env.ELECTRON_RENDERER_URL
const app=await electron.launch({executablePath:require('electron'),args:['out/main/index.js'],env})
try {
 const page=await app.firstWindow(); page.setDefaultTimeout(15000)
 await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.hide()})
 await page.context().setOffline(true)
 await page.getByLabel('Paste your SimC addon string').fill(readFileSync('fixtures/vahshandooz-elemental.simc','utf8'))
 await page.getByRole('button',{name:'Top Gear',exact:true}).click()
 await page.getByLabel('Search items',{exact:true}).fill('251233')
 const drop=page.getByRole('button',{name:/Manipulator.*251233/})
 await drop.locator('strong').hover()
 const tip=page.getByRole('tooltip')
 await expect(tip.locator('.tip-stats')).toBeVisible()
 await expect(tip).toContainText('Item level 266')
 const before=await tip.locator('.tip-stats').innerText()
 await drop.click()
 await page.getByLabel('Upgrade track').selectOption('Myth')
 await page.getByLabel('Item level',{exact:true}).selectOption('334')
 await page.locator('.item-preview strong').hover()
 await expect(tip.locator('.tip-stats')).toBeVisible()
 await expect(tip).toContainText('Item level 334')
 assert.notEqual(await tip.locator('.tip-stats').innerText(),before)
 await page.getByRole('button',{name:'Crafted',exact:true}).click()
 await page.getByLabel('Search crafted items',{exact:true}).fill('244582')
 const craft=page.getByRole('button',{name:/Farstrider.*244582/})
 await expect(craft.locator('img.item-icon')).toBeVisible()
 assert(await craft.locator('img').evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0))
 await craft.locator('strong').hover()
 await expect(tip.locator('.tip-stats')).toBeVisible()
 await expect(tip).toContainText('Preview: quality 5')
 await craft.click()
 await page.getByLabel('Versatility',{exact:true}).check()
 await page.getByLabel('Mastery',{exact:true}).check()
 await page.locator('.item-preview strong').hover()
 await expect(tip.locator('.tip-stats')).toContainText('Versatility')
 await expect(tip.locator('.tip-stats')).toContainText('Mastery')
 await expect(tip.locator('.tip-stats')).not.toContainText('Haste')
 await page.screenshot({path:'data/ui-crafted-stats.png'})
 await page.getByRole('button',{name:'Add crafted item',exact:true}).click()
 await page.locator('.hypothetical-list .hyp-name').last().hover()
 await expect(tip.locator('.tip-stats')).toContainText('Versatility')
 await expect(tip.locator('.tip-stats')).toContainText('Mastery')
 console.log('Offline stats without a user simulation: search, configured level, crafted defaults, chosen stats, hypothetical copy and loaded crafted icon passed')
 await page.keyboard.press('Escape')
 const yielded = await page.evaluate(async raw => {
   const api = (window as unknown as {simitboi:SimItBoiApi}).simitboi
   const run = api.runSim(raw, {iterations:1})
   const preview = await api.itemPreview(raw, {selection:{itemId:251233,track:'Myth',ilvl:331}})
   const completed = await run
   return {preview, ok:completed.ok}
 }, readFileSync('fixtures/vahshandooz-elemental.simc','utf8'))
 assert(yielded.ok)
 assert(yielded.preview.ok && yielded.preview.state.status === 'pending', 'Preview must yield to foreground simulation')
 console.log('Preview yields to foreground simulation passed')
} finally {await app.close()}
