/**
 * 读插件缓存的模型目录（`catalog.json`），用于「运行」页展示本账号实际可见的模型。
 * 只读，插件写、面板读。
 * @module antigravity-dashboard/catalog
 */

import { existsSync, readFileSync } from 'node:fs'

/** 与插件 `${DSH_HOME}/cache/antigravity-acp/catalog.json` 一致。 */
export const CATALOG_PATH = process.env.CATALOG_JSON
  ?? `${process.env.DSH_HOME ?? '/root/.dsh'}/cache/antigravity-acp/catalog.json`

/**
 * @param {string} [path]
 * @returns {{available: boolean, path: string, models: {id: string, name: string}[], efforts: string[], byModel: Record<string, string[]>, error?: string}}
 */
export function readCatalog(path = CATALOG_PATH) {
  if (!existsSync(path)) {
    return { available: false, path, models: [], efforts: [], byModel: {}, error: 'catalog.json 还不存在（插件尚未读到 ACP 模型目录）' }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const models = (Array.isArray(parsed?.models) ? parsed.models : [])
      .filter(entry => typeof entry?.id === 'string')
      .map(entry => ({ id: entry.id, name: String(entry.name ?? entry.id) }))
    return {
      available: true,
      path,
      models,
      efforts: (Array.isArray(parsed?.efforts) ? parsed.efforts : []).filter(entry => typeof entry === 'string'),
      byModel: parsed?.byModel !== null && typeof parsed?.byModel === 'object' ? parsed.byModel : {},
    }
  } catch (error) {
    return { available: false, path, models: [], efforts: [], byModel: {}, error: error instanceof Error ? error.message : String(error) }
  }
}
