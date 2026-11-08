/**
 * 模型分类：构建提示词、解析校验、调用默认模型，失败时退化为关键词归类。
 *
 * 分类输入是「工具 + 技能」的轻量清单（名称、截断后的描述），
 * 输出是类别列表；不涉及工具执行，也不修改工具注册。
 */

const MAX_DESCRIPTION = 320
const MAX_CATEGORY_MEMBERS = 40
const MIN_CATEGORIES = 2
const MAX_CATEGORIES = 12

export function buildClassificationPrompt(items, existingCategories = [], { incremental = false } = {}) {
  const list = items
    .map((item) => {
      const desc = String(item.description ?? '').replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION)
      return `- ${item.kind}:${item.name}${desc ? ` — ${desc}` : ''}`
    })
    .join('\n')

  const existing = existingCategories.length
    ? existingCategories
        .map((category) => `- ${category.name}：${category.description || '（无描述）'}`)
        .join('\n')
    : '（还没有分类）'

  const system = [
    '你是 DeepSeek Harness 的工具目录管理员。',
    '你的任务是把工具（tool）与技能（skill）按“用户任务场景”归类，而不是按实现方式归类。',
    '只输出一个 JSON 对象，不要 Markdown、不要解释。',
  ].join('\n')

  const rules = [
    `1. 输出 ${MIN_CATEGORIES}–${MAX_CATEGORIES} 个类别，类别名用 2–6 个中文字，描述一句话。`,
    '2. 每个条目必须且只能出现在一个类别里，members 用 "tool:<名称>" 或 "skill:<名称>"。',
    '3. 同一类别的工具应当是用户做同一类任务时会一起用到的；不要按插件来源或字母排序分类。',
    '4. 类别名要具体（如“文档与知识库”“求职与招聘”“日程与提醒”），不要用“其他工具”兜底，除非确实无法归类。',
    incremental ? '5. 已有类别可复用：名称完全一致时会被合并；新能力适合旧类别就沿用旧类别名。' : '',
  ].filter(Boolean).join('\n')

  const user = [
    `已有分类：\n${existing}`,
    `待分类条目（${items.length} 个）：\n${list}`,
    `规则：\n${rules}`,
    '输出格式：',
    '{"categories":[{"name":"类别名","description":"一句话描述","members":["tool:foo","skill:bar"]}]}',
  ].join('\n\n')

  return { system, user }
}

export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('模型返回为空')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型返回中没有 JSON 对象')
  return JSON.parse(body.slice(start, end + 1))
}

/**
 * 把模型输出解析为类别列表，并校验覆盖性。
 * @param {string} text
 * @param {Array<{kind:string,name:string}>} items
 */
export function parseClassification(text, items) {
  const data = extractJson(text)
  if (!data || !Array.isArray(data.categories)) throw new Error('JSON 缺少 categories 数组')
  const valid = new Map(items.map((item) => [`${item.kind}:${item.name}`, item]))
  const assigned = new Map()
  const categories = []

  for (const raw of data.categories) {
    if (!raw || typeof raw !== 'object') continue
    const name = String(raw.name ?? '').trim().slice(0, 30)
    if (!name) continue
    const category = {
      name,
      description: String(raw.description ?? '').trim().slice(0, 200),
      tools: [],
      skills: [],
    }
    for (const member of Array.isArray(raw.members) ? raw.members : []) {
      const key = String(member ?? '').trim()
      if (!valid.has(key)) continue
      if (assigned.has(key)) continue
      assigned.set(key, name)
      if (key.startsWith('tool:')) category.tools.push(key.slice(5))
      else category.skills.push(key.slice(6))
    }
    if (category.tools.length || category.skills.length) categories.push(category)
  }

  const missing = [...valid.keys()].filter((key) => !assigned.has(key))
  return { categories, missing }
}

/** 把一次分类结果合并进已有目录（按类别名合并）。 */
export function mergeClassification(catalog, categories, items, fallbackName = '未分类') {
  const merged = new Map(
    catalog.categories.map((category) => [
      category.name.toLowerCase(),
      { name: category.name, description: category.description, tools: [...category.tools], skills: [...category.skills] },
    ]),
  )
  const assigned = new Set()
  for (const category of catalog.categories) {
    for (const tool of category.tools) assigned.add(`tool:${tool}`)
    for (const skill of category.skills) assigned.add(`skill:${skill}`)
  }
  for (const category of categories) {
    const key = category.name.toLowerCase()
    const target = merged.get(key) ?? { name: category.name, description: category.description, tools: [], skills: [] }
    for (const tool of category.tools) {
      if (assigned.has(`tool:${tool}`)) continue
      assigned.add(`tool:${tool}`)
      if (!target.tools.includes(tool)) target.tools.push(tool)
    }
    for (const skill of category.skills) {
      if (assigned.has(`skill:${skill}`)) continue
      assigned.add(`skill:${skill}`)
      if (!target.skills.includes(skill)) target.skills.push(skill)
    }
    merged.set(key, target)
  }
  const leftovers = items.filter((item) => !assigned.has(`${item.kind}:${item.name}`))
  if (leftovers.length) {
    const bucket = merged.get(fallbackName.toLowerCase()) ?? {
      name: fallbackName,
      description: '模型未归类的工具与技能',
      tools: [],
      skills: [],
    }
    for (const item of leftovers) {
      if (item.kind === 'tool' && !bucket.tools.includes(item.name)) bucket.tools.push(item.name)
      if (item.kind === 'skill' && !bucket.skills.includes(item.name)) bucket.skills.push(item.name)
    }
    merged.set(fallbackName.toLowerCase(), bucket)
  }
  return {
    version: catalog.version,
    updatedAt: catalog.updatedAt,
    model: catalog.model,
    categories: [...merged.values()]
      .filter((category) => category.tools.length || category.skills.length)
      .map((category) => ({ ...category, tools: category.tools.slice(0, MAX_CATEGORY_MEMBERS), skills: category.skills.slice(0, MAX_CATEGORY_MEMBERS) })),
  }
}

// ---------- 模型调用 ----------

function selectionOf(defaultModel) {
  if (!defaultModel) return null
  const value = typeof defaultModel.currentSelection === 'function'
    ? defaultModel.currentSelection()
    : defaultModel.currentSelection
  if (!value || typeof value !== 'object') return null
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  return value
}

export async function callModel(ctx, { system, user, plugin = 'dsh-tool-router', timeoutMs = 90_000, temperature = 0.2 }) {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  const selection = selectionOf(defaultModel)
  if (!llm || !selection) throw new Error('当前没有可用的默认模型服务')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('tool-router classification timed out'), timeoutMs)
  let text = ''
  let blockText = ''
  try {
    const messageId = `tool-router-classify-${Date.now()}-${Math.random().toString(36).slice(2)}`
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      messages: [{
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin },
      }],
      system,
      temperature,
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        blockText += chunk.block.text
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return (text || blockText).trim()
}

/**
 * 让模型分类一批条目；校验失败会把错误反馈给模型重试一次，最终失败则关键词兜底。
 */
export async function classifyItems(ctx, items, existingCategories = [], options = {}) {
  const { incremental = false, maxAttempts = 2, logger = () => {} } = options
  if (!items.length) return { categories: [], model: '', fallback: false, error: null }
  const prompt = buildClassificationPrompt(items, existingCategories, { incremental })
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const user = attempt === 1
        ? prompt.user
        : `${prompt.user}\n\n上一次输出有问题：${lastError?.message ?? '格式不符合要求'}。请严格按 JSON 格式重新输出，确保每个条目恰好出现一次。`
      const text = await callModel(ctx, { system: prompt.system, user })
      const { categories, missing } = parseClassification(text, items)
      if (!categories.length) throw new Error('模型没有给出任何有效类别')
      if (missing.length) throw new Error(`还有 ${missing.length} 个条目没有归类，例如 ${missing.slice(0, 3).join('、')}`)
      if (!incremental && categories.length < MIN_CATEGORIES) throw new Error(`类别太少（${categories.length} 个），至少 ${MIN_CATEGORIES} 个`)
      return { categories, model: 'default', fallback: false, error: null }
    } catch (error) {
      lastError = error
      logger(`classification attempt ${attempt} failed: ${error?.message ?? error}`)
    }
  }

  const fallback = heuristicCategories(items)
  return { categories: fallback, model: 'heuristic', fallback: true, error: lastError?.message ?? '模型分类失败' }
}

// ---------- 关键词兜底（仅在模型不可用时使用） ----------

const RULES = [
  ['文档与知识库', ['文档', '知识库', '检索', '搜索', '论文', 'pdf', 'docx', 'read', 'file', 'kb', 'search', 'rag', '简历']],
  ['记忆与待办', ['记忆', 'memory', '习惯', '画像', '待办', 'todo', '日志', 'skill', '技能']],
  ['网络与情报', ['网页', '联网', 'http', 'web', 'fetch', '浏览器', 'browser', '抓取', 'url']],
  ['日程与自动化', ['日程', '提醒', '定时', 'schedule', 'cron', '自动化']],
  ['代理与编排', ['子代理', 'subagent', 'workflow', '工作流', '代理', '任务编排', 'delegate']],
  ['界面与呈现', ['界面', '渲染', '图表', 'ui', 'render', 'present', 'image', '图片', '可视化']],
  ['系统与文件', ['shell', 'bash', '终端', '文件', '目录', 'glob', 'grep', 'edit', 'write', 'read_file', '系统']],
]

export function heuristicCategoryFor(item) {
  const text = `${item.name} ${item.description ?? ''}`.toLowerCase()
  for (const [category, keywords] of RULES) {
    if (keywords.some((keyword) => text.includes(keyword))) return category
  }
  return '其他'
}

export function heuristicCategories(items) {
  const buckets = new Map()
  for (const item of items) {
    const name = heuristicCategoryFor(item)
    const bucket = buckets.get(name) ?? { name, description: '按关键词粗略归类', tools: [], skills: [] }
    if (item.kind === 'tool') bucket.tools.push(item.name)
    else bucket.skills.push(item.name)
    buckets.set(name, bucket)
  }
  return [...buckets.values()]
}
