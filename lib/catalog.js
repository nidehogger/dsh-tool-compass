/**
 * 目录数据与检索：分类的持久化、渲染、关键词打分。
 *
 * 目录条目只保存「类别 → 工具名 / 技能名」，不保存 schema；
 * 具体工具描述在检索时从运行时动态读取，避免目录文件过期。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CATALOG_VERSION = 1

export function emptyCatalog() {
  return { version: CATALOG_VERSION, updatedAt: null, model: '', categories: [] }
}

export function loadCatalog(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || !Array.isArray(data.categories)) return emptyCatalog()
    return {
      version: CATALOG_VERSION,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      model: typeof data.model === 'string' ? data.model : '',
      categories: normalizeCategories(data.categories),
    }
  } catch {
    return emptyCatalog()
  }
}

export function saveCatalog(file, catalog) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  const payload = {
    version: CATALOG_VERSION,
    updatedAt: new Date().toISOString(),
    model: catalog.model ?? '',
    categories: normalizeCategories(catalog.categories),
  }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  return payload
}

export function normalizeCategories(categories) {
  const seenCategory = new Set()
  const seenMember = new Set()
  const out = []
  for (const raw of categories) {
    if (!raw || typeof raw !== 'object') continue
    const name = String(raw.name ?? '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seenCategory.has(key)) continue
    seenCategory.add(key)
    const tools = []
    const skills = []
    for (const value of Array.isArray(raw.tools) ? raw.tools : []) {
      const member = String(value ?? '').trim()
      if (!member || seenMember.has(member)) continue
      seenMember.add(member)
      tools.push(member)
    }
    for (const value of Array.isArray(raw.skills) ? raw.skills : []) {
      const member = String(value ?? '').trim()
      if (!member || seenMember.has(member)) continue
      seenMember.add(member)
      skills.push(member)
    }
    out.push({
      name,
      description: String(raw.description ?? '').trim().slice(0, 200),
      tools,
      skills,
    })
  }
  return out
}

export function categoryOf(catalog, toolName) {
  for (const category of catalog.categories) {
    if (category.tools.includes(toolName)) return category.name
  }
  return ''
}

export function skillCategoryOf(catalog, skillName) {
  for (const category of catalog.categories) {
    if (category.skills.includes(skillName)) return category.name
  }
  return ''
}

export function knownTools(catalog) {
  return new Set(catalog.categories.flatMap((category) => category.tools))
}

export function knownSkills(catalog) {
  return new Set(catalog.categories.flatMap((category) => category.skills))
}

/** 模型可见的分类目录文本；不列具体工具名，避免重新膨胀上下文。 */
export function renderCatalog(catalog, { totalTools = 0, totalSkills = 0 } = {}) {
  if (!catalog.categories.length) {
    return '【工具分类目录】正在建立分类，暂未完成；当前仍按原工具列表工作。'
  }
  const lines = catalog.categories
    .map((category) => {
      const parts = []
      if (category.tools.length) parts.push(`${category.tools.length} 个工具`)
      if (category.skills.length) parts.push(`${category.skills.length} 个技能`)
      const desc = category.description ? `：${category.description}` : ''
      return `- ${category.name}（${parts.join('、') || '空'}）${desc}`
    })
    .join('\n')
  return [
    '【工具分类目录】为节省上下文，默认只展示类别；具体工具需要先用 tool_search 检索并开放。',
    lines,
    '需要某类能力时调用 tool_search("关键词")；它会返回匹配的工具/技能并开放对应工具。技能需再用 skill 工具加载。',
    `当前共分类 ${totalTools} 个工具、${totalSkills} 个技能。`,
  ].join('\n')
}

const CJK = /[\u3400-\u9fff]/

export function tokenize(query) {
  const text = String(query ?? '').toLowerCase().trim()
  if (!text) return []
  const tokens = new Set()
  for (const word of text.split(/[^a-z0-9_\u3400-\u9fff]+/)) {
    if (!word) continue
    if (CJK.test(word)) {
      if (word.length <= 2) tokens.add(word)
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2))
    } else if (word.length >= 2) {
      tokens.add(word)
    }
  }
  return [...tokens]
}

function scoreItem(item, query, tokens) {
  const q = query.toLowerCase()
  const name = item.name.toLowerCase()
  const description = (item.description ?? '').toLowerCase()
  const category = (item.category ?? '').toLowerCase()
  let score = 0
  if (q && name.includes(q)) score += 20
  if (q && description.includes(q)) score += 8
  if (q && category.includes(q)) score += 5
  for (const token of tokens) {
    if (name.includes(token)) score += 4
    if (description.includes(token)) score += 1
    if (category.includes(token)) score += 2
  }
  return score
}

/**
 * items: [{ kind: 'tool'|'skill', name, description, category }]
 * 返回打分排序后的前 k 条；0 分的条目不返回。
 */
export function searchItems(items, query, k = 6) {
  const tokens = tokenize(query)
  return items
    .map((item) => ({ item, score: scoreItem(item, String(query ?? '').trim(), tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, Math.max(1, k))
    .map((entry) => ({ ...entry.item, score: entry.score }))
}
