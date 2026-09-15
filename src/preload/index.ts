import { contextBridge, ipcRenderer } from 'electron'
import type { SimProgress } from '../core/simc/runner.ts'
import type { UpdateProgress } from '../core/simc/update.ts'
import type { TopGearOptions, TopGearProgress } from '../core/topgear/funnel.ts'
import type { SimItBoiApi } from '../core/api.ts'
import type { ReportKind } from '../core/store/db.ts'

const api: SimItBoiApi = {
  itemPreview: (raw, request, cancel) => ipcRenderer.invoke('items:preview', raw, request, cancel),
  searchItems: (raw, query, slot) => ipcRenderer.invoke('items:search', raw, query, slot),
  configureItem: (raw, selection) => ipcRenderer.invoke('items:configure', raw, selection),
  gearOptions: () => ipcRenderer.invoke('items:gearOptions'),
  craftableItems: (raw, query, slot) => ipcRenderer.invoke('items:craftable', raw, query, slot),
  configureCrafted: (raw, selection) => ipcRenderer.invoke('items:configureCrafted', raw, selection),
  envInfo: () => ipcRenderer.invoke('env:info'),
  simcVersion: () => ipcRenderer.invoke('simc:version'),
  simcBuilds: () => ipcRenderer.invoke('simc:builds'),
  activateSimcBuild: (buildId: string) => ipcRenderer.invoke('simc:activate', buildId),
  rollbackSimcBuild: () => ipcRenderer.invoke('simc:rollback'),
  checkSimcUpdate: (force?: boolean) => ipcRenderer.invoke('simc:checkUpdate', force),
  installSimcUpdate: () => ipcRenderer.invoke('simc:installUpdate'),
  onSimcUpdateProgress: (cb: (p: UpdateProgress) => void) => {
    const handler = (_e: unknown, p: UpdateProgress): void => cb(p)
    ipcRenderer.on('simc:updateProgress', handler)
    return () => { ipcRenderer.off('simc:updateProgress', handler) }
  },
  parseProfile: (raw: string) => ipcRenderer.invoke('profile:parse', raw),
  armoryStatus: () => ipcRenderer.invoke('armory:status'),
  importArmory: (lookup) => ipcRenderer.invoke('armory:import', lookup),
  armoryRealms: (region) => ipcRenderer.invoke('armory:realms', region),
  characterPortrait: (lookup) => ipcRenderer.invoke('armory:portrait', lookup),
  setArmoryCredentials: (credentials) => ipcRenderer.invoke('armory:setCredentials', credentials),
  runSim: (raw: string, opts?: { iterations?: number }) =>
    ipcRenderer.invoke('sim:run', raw, opts ?? {}),
  cancelSim: () => ipcRenderer.invoke('sim:cancel'),
  runLoadouts: (raw: string, opts?: { threads?: number; fightSeconds?: number }) =>
    ipcRenderer.invoke('loadouts:run', raw, opts ?? {}),
  listHistory: (opts?: { kind?: ReportKind; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('history:list', opts ?? {}),
  getHistory: (id: string) => ipcRenderer.invoke('history:get', id),
  deleteHistory: (id: string) => ipcRenderer.invoke('history:delete', id),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  getProfile: (checksum: string) => ipcRenderer.invoke('profiles:get', checksum),
  rememberProfile: (raw: string) => ipcRenderer.invoke('profile:remember', raw),
  itemStats: (raw: string) => ipcRenderer.invoke('items:stats', raw),
  cancelItemStats: (raw: string) => ipcRenderer.invoke('items:stats:cancel', raw),
  runTopGear: (raw: string, opts: TopGearOptions) => ipcRenderer.invoke('topgear:run', raw, opts),
  onTopGearProgress: (cb: (p: TopGearProgress) => void) => {
    const handler = (_e: unknown, p: TopGearProgress): void => cb(p)
    ipcRenderer.on('topgear:progress', handler)
    return () => { ipcRenderer.off('topgear:progress', handler) }
  },
  onProgress: (cb: (p: SimProgress) => void) => {
    const handler = (_e: unknown, p: SimProgress): void => cb(p)
    ipcRenderer.on('sim:progress', handler)
    return () => { ipcRenderer.off('sim:progress', handler) }
  }
}

contextBridge.exposeInMainWorld('simitboi', api)
