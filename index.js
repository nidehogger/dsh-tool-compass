/**
 * dsh-tool-router — 按功能分类工具，模型默认只看类别，检索后按需开放。
 *
 * 行为：
 *   1. 安装后（首次）调用默认模型，把全部 tools + skills 按功能分类并落盘；
 *   2. 监听 tools/change，发现新工具时再次调用模型做增量归类；
 *   3. 每个 Agent 只保留核心工具，其余工具默认隐藏；分类目录写入系统提示；
 *   4. 模型调用 tool_search(query) 检索，命中的工具对本会话开放（下一轮可见）；
 *   5. 任何一步失败都 fail-open：恢复原工具可见性，不影响正常使用。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  emptyCatalog,
  loadCatalog,
  saveCatalog,
  renderCatalog,
  normalizeCategories,
  categoryOf,
  skillCategoryOf,
  knownTools,
  knownSkills,
  searchItems,
} from './lib/catalog.js'
import { classifyItems, mergeClassification } from './lib/classify.js'

export const name = 'tool-compass'
export const inject = ['tools', 'systemPrompt']

const ROUTER_TOOLS = new Set(['tool_search', 'tool_catalog', 'tool_router_refresh', 'tool_router_status'])

const DEFAULT_ALWAYS_VISIBLE = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'todo_write',
  'skill',
  'ask_user_question',
  'present',
]

function normalizeConfig(raw = {}) {
  const catalogPath = typeof raw.catalogPath === 'string' && raw.catalogPath.trim()
    ? raw.catalogPath.trim()
    : join(homedir(), '.dsh', 'tool-compass.json')
  return {
    enabled: raw.enabled !== false,
    catalogPath,
    classifyOnStart: raw.classifyOnStart !== false,
    classifyOnChange: raw.classifyOnChange !== false,
    classifyDelayMs: Number.isFinite(raw.classifyDelayMs) ? Math.max(500, raw.classifyDelayMs) : 4_000,
    searchLimit: Number.isFinite(raw.searchLimit) ? Math.min(Math.max(1, raw.searchLimit), 20) : 6,
    alwaysVisible: Array.isArray(raw.alwaysVisible)
      ? raw.alwaysVisible.map((item) => String(item).trim()).filter(Boolean)
      : DEFAULT_ALWAYS_VISIBLE,
  }
}

function asAgent(payload) {
  if (!payload) return null
  if (payload.agent) return payload.agent
  if (payload.ctx && payload.session) return payload
  return null
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  const log = (...args) => console.error('[tool-router]', ...args)
  const state = {
    catalog: loadCatalog(config.catalogPath),
    agents: new Map(),
    skills: [],
    classifying: false,
    refreshTimer: null,
    startupTimer: null,
    lastError: null,
  }

  const visibleNames = new Set([...config.alwaysVisible, ...ROUTER_TOOLS])

  // ---------- agent 状态与工具可见性 ----------

  function readSchemas(agent) {
    const tools = agent?.ctx?.get?.('tools')
    if (!tools) return []
    try {
      return tools.schemas(agent) ?? []
    } catch (error) {
      log('schemas() failed:', error?.message ?? error)
      return []
    }
  }

  function applyRestriction(st) {
    st.restriction?.()
    st.restriction = null
    if (!state.catalog.categories.length) return
    const deny = [...st.baseline.keys()].filter((name) => !visibleNames.has(name) && !st.exposed.has(name))
    if (!deny.length) return
    const tools = st.agent?.ctx?.get?.('tools')
    if (!tools?.restrict) return
    try {
      st.restriction = tools.restrict({ deny })
    } catch (error) {
      // deny 里可能混入已卸载/Agent 自身作用域的工具；按错误信息里的已知工具集合
      // 过滤后重试，避免一个陈旧名字导致整张限制被放弃。
      const message = String(error?.message ?? error)
      const marker = 'known global tools: '
      const index = message.lastIndexOf(marker)
      const listed = index >= 0 ? message.slice(index + marker.length).trim() : ''
      if (index >= 0) {
        const known = new Set(listed === '(none)' || !listed ? [] : listed.split(', ').map((item) => item.trim()))
        const next = deny.filter((name) => known.has(name))
        try {
          st.restriction = next.length ? tools.restrict({ deny: next }) : null
          if (!st.restriction) log(`restrict() skipped: none of ${deny.length} names are restrictable`)
          return
        } catch (retryError) {
          log('restrict() retry failed, fail-open:', retryError?.message ?? retryError)
        }
      } else {
        log('restrict() failed, fail-open:', message)
      }
      st.restriction = null
    }
  }

  function installAgent(agent) {
    if (!agent || state.agents.has(agent)) return
    const tools = agent.ctx?.get?.('tools')
    if (!tools) return
    const schemas = readSchemas(agent)
    const baseline = new Map(schemas.map((schema) => [schema.name, schema]))
    const st = { agent, baseline, exposed: new Set(), restriction: null }
    state.agents.set(agent, st)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        st.restriction?.()
        st.restriction = null
      }, 'tool-router: restriction cleanup')
    }
    applyRestriction(st)
    if (!state.catalog.categories.length && config.classifyOnStart) {
      setTimeout(() => {
        refreshAndClassify().catch((error) => log('agent classification failed:', error?.message ?? error))
      }, 400)?.unref?.()
    }
  }

  function reconcileAgent(st) {
    applyRestriction(st)
  }

  function reconcileAll() {
    for (const st of state.agents.values()) reconcileAgent(st)
  }

  function refreshBaselines() {
    // 只增不减：restriction 生效时 schemas() 看到的是裁剪后的集合，
    // 直接重建 baseline 会把已隐藏的工具永久丢掉。新注册的工具不会被
    // 旧 deny 覆盖，因此“可见但 baseline 没有”就是新工具的证据。
    for (const st of state.agents.values()) {
      const visible = readSchemas(st.agent)
      let changed = false
      for (const schema of visible) {
        if (st.baseline.has(schema.name)) continue
        st.baseline.set(schema.name, schema)
        changed = true
      }
      if (changed) applyRestriction(st)
    }
  }

  // ---------- 目录与检索项 ----------

  function collectItems() {
    const items = []
    const seen = new Set()
    for (const st of state.agents.values()) {
      for (const [toolName, schema] of st.baseline) {
        if (seen.has(`tool:${toolName}`) || ROUTER_TOOLS.has(toolName)) continue
        seen.add(`tool:${toolName}`)
        items.push({ kind: 'tool', name: toolName, description: schema.description ?? '' })
      }
    }
    for (const skill of state.skills) {
      if (seen.has(`skill:${skill.name}`)) continue
      seen.add(`skill:${skill.name}`)
      items.push({ kind: 'skill', name: skill.name, description: skill.description ?? '' })
    }
    return items
  }

  function searchItemsForAgent(st) {
    const items = []
    if (st) {
      for (const [toolName, schema] of st.baseline) {
        if (ROUTER_TOOLS.has(toolName)) continue
        items.push({
          kind: 'tool',
          name: toolName,
          description: schema.description ?? '',
          category: categoryOf(state.catalog, toolName) || '未分类',
        })
      }
    }
    for (const skill of state.skills) {
      items.push({
        kind: 'skill',
        name: skill.name,
        description: skill.description ?? '',
        category: skillCategoryOf(state.catalog, skill.name) || '未分类',
      })
    }
    return items
  }

  async function loadSkills() {
    try {
      const service = ctx.get('skills')
      const sample = [...state.agents.values()][0]?.agent
      const cwd = sample?.session?.header?.cwd
      const list = await service?.list?.({
        ...(cwd ? { cwd } : {}),
        ...(sample ? { scope: sample } : {}),
      })
      if (Array.isArray(list)) {
        state.skills = list.map((item) => ({ name: String(item.name ?? ''), description: String(item.description ?? '') })).filter((item) => item.name)
      }
    } catch (error) {
      log('skills.list() failed:', error?.message ?? error)
    }
  }

  // ---------- 模型分类 ----------

  function pruneCatalog(catalog, toolNames, skillNames) {
    return {
      ...catalog,
      categories: catalog.categories
        .map((category) => ({
          ...category,
          tools: category.tools.filter((tool) => toolNames.has(tool)),
          skills: category.skills.filter((skill) => skillNames.has(skill)),
        }))
        .filter((category) => category.tools.length || category.skills.length),
    }
  }

  function save(result, existing, items) {
    const catalog = existing
      ? mergeClassification(existing, result.categories, items ?? collectItems())
      : {
          ...emptyCatalog(),
          categories: normalizeCategories(result.categories),
          model: result.model ?? '',
        }
    catalog.model = result.model ?? ''
    state.catalog = saveCatalog(config.catalogPath, catalog)
    state.lastError = result.error ?? null
    log(`catalog saved: ${state.catalog.categories.length} categories, model=${state.catalog.model}${result.fallback ? ' (fallback)' : ''}`)
    reconcileAll()
    return state.catalog
  }

  async function classifyAll(reason) {
    if (state.classifying) return
    const items = collectItems()
    if (!items.length) return
    state.classifying = true
    try {
      log(`full classification (${reason}), ${items.length} items`)
      const result = await classifyItems(ctx, items, [], { logger: log })
      save(result, null, items)
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      log('full classification failed:', state.lastError)
    } finally {
      state.classifying = false
    }
  }

  async function classifyNew(reason) {
    if (state.classifying) return
    const items = collectItems()
    if (!items.length) return
    const known = new Set([...knownTools(state.catalog), ...knownSkills(state.catalog)])
    const fresh = items.filter((item) => !known.has(item.name))
    if (!fresh.length) return
    state.classifying = true
    try {
      log(`incremental classification (${reason}), ${fresh.length} new items`)
      const result = await classifyItems(ctx, fresh, state.catalog.categories, { incremental: true, logger: log })
      save(result, state.catalog, fresh)
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      log('incremental classification failed:', state.lastError)
    } finally {
      state.classifying = false
    }
  }

  async function refreshAndClassify() {
    await loadSkills()
    refreshBaselines()
    const toolNames = new Set()
    for (const st of state.agents.values()) for (const name of st.baseline.keys()) toolNames.add(name)
    const skillNames = new Set(state.skills.map((skill) => skill.name))
    if (state.agents.size > 0) state.catalog = pruneCatalog(state.catalog, toolNames, skillNames)
    if (!state.catalog.categories.length) {
      if (config.classifyOnStart) await classifyAll('startup')
    } else if (config.classifyOnChange || config.classifyOnStart) {
      await classifyNew('refresh')
    }
    reconcileAll()
  }

  // ---------- 工具注册 ----------

  function register(def, label) {
    try {
      if (typeof ctx.effect === 'function') {
        return ctx.effect(() => ctx.tools.register(def), label)
      }
      return ctx.tools.register(def)
    } catch (error) {
      log(`register ${def.name} failed:`, error?.message ?? error)
      return undefined
    }
  }

  const textRender = (args, value) => [{ type: 'text', text: value?.message ?? '' }]

  register({
    name: 'tool_search',
    description: [
      '按功能检索工具与技能。默认只展示工具分类目录；需要具体能力时调用本工具，',
      '它会返回匹配项的描述，并把命中的工具开放给当前会话（下一步可直接调用）。',
      '技能命中后用 skill 工具加载。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '任务或能力关键词，例如“发邮件”“数据库”“日程提醒”' },
        limit: { type: 'integer', description: '返回条数，默认 6' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          opened: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'message'],
      },
      render: textRender,
    },
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, message: 'query 不能为空', opened: [] }
      const st = exec?.agent ? state.agents.get(exec.agent) : undefined
      if (!st) return { ok: false, message: '当前会话尚未注册工具路由，请重试或重启 DSH。', opened: [] }

      const limit = Math.min(Math.max(Number(args.limit) || config.searchLimit, 1), 20)
      const hits = searchItems(searchItemsForAgent(st), query, limit)
      if (!hits.length) {
        return { ok: false, message: `没有找到与「${query}」匹配的工具。可调用 tool_catalog 查看类别，或换一个更具体的词。`, opened: [] }
      }

      const opened = []
      for (const hit of hits) {
        if (hit.kind !== 'tool') continue
        if (!st.baseline.has(hit.name)) continue
        if (visibleNames.has(hit.name)) continue
        if (!st.exposed.has(hit.name)) {
          st.exposed.add(hit.name)
          opened.push(hit.name)
        }
      }
      if (opened.length) reconcileAgent(st)

      const lines = hits.map((hit, index) => {
        const kind = hit.kind === 'skill' ? '技能' : '工具'
        const stateText = hit.kind === 'skill'
          ? '用 skill 工具加载'
          : (visibleNames.has(hit.name) || st.exposed.has(hit.name) ? '已开放，可直接调用' : '未开放')
        const desc = hit.description ? ` — ${String(hit.description).replace(/\s+/g, ' ').slice(0, 240)}` : ''
        return `${index + 1}. [${kind}] ${hit.name}（${hit.category}）${desc}\n   ${stateText}`
      })
      return {
        ok: true,
        message: `匹配到 ${hits.length} 项：\n${lines.join('\n')}${opened.length ? `\n\n已开放 ${opened.length} 个工具，下一步可直接调用。` : ''}`,
        opened,
      }
    },
  }, 'tool-router: tool_search')

  register({
    name: 'tool_catalog',
    description: '查看当前工具/技能的功能分类目录（只有类别与数量，不含完整 schema）。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: textRender,
    },
    async execute() {
      return {
        ok: true,
        message: renderCatalog(state.catalog, {
          totalTools: knownTools(state.catalog).size,
          totalSkills: knownSkills(state.catalog).size,
        }),
      }
    },
  }, 'tool-router: tool_catalog')

  register({
    name: 'tool_router_refresh',
    description: '重新加载技能并触发工具分类（new=只归类新增，all=清空后全量重建）。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['new', 'all'], description: 'new 增量（默认），all 全量重建' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: textRender,
    },
    async execute(args) {
      const mode = args.mode === 'all' ? 'all' : 'new'
      await loadSkills()
      refreshBaselines()
      if (mode === 'all') state.catalog = emptyCatalog()
      await refreshAndClassify()
      return {
        ok: true,
        message: `已刷新（${mode}）：${state.catalog.categories.length} 个类别，${knownTools(state.catalog).size} 个工具，${knownSkills(state.catalog).size} 个技能。`,
      }
    },
  }, 'tool-router: tool_router_refresh')

  register({
    name: 'tool_router_status',
    description: '查看工具路由状态：目录分类数、已登记工具数、当前可见工具数，以及是否需要重建目录。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: textRender,
    },
    async execute(_args, exec) {
      const st = exec?.agent ? state.agents.get(exec.agent) : undefined
      const baseline = st ? st.baseline.size : 0
      const visible = st ? readSchemas(st.agent).length : 0
      const catalogTools = knownTools(state.catalog).size
      const catalogSkills = knownSkills(state.catalog).size
      const missing = Math.max(0, baseline - catalogTools - ROUTER_TOOLS.size)
      const hint = missing > 0
        ? `目录缺 ${missing} 个已登记工具，调用 tool_router_refresh(mode="all") 或重启 DSH 可修复`
        : '目录与工具面一致'
      return {
        ok: true,
        message: `目录：${state.catalog.categories.length} 类 / ${catalogTools} 工具 / ${catalogSkills} 技能；已登记 ${baseline}，当前可见 ${visible}。${hint}`,
      }
    },
  }, 'tool-router: tool_router_status')

  // ---------- 系统提示目录 ----------

  ctx.systemPrompt.section({
    name: 'tool-router:catalog',
    order: 150,
    text: () => renderCatalog(state.catalog, {
      totalTools: knownTools(state.catalog).size,
      totalSkills: knownSkills(state.catalog).size,
    }),
    interpolate: false,
  })

  // ---------- 生命周期 ----------

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const st of state.agents.values()) st.restriction?.()
      state.agents.clear()
    }, 'tool-router: shutdown cleanup')
  }

  const agentsService = ctx.get('agents')
  for (const agent of agentsService?.list?.() ?? []) installAgent(agent)

  ctx.on('agent/created', (...args) => installAgent(asAgent(args[0])))
  ctx.on('agent/disposed', (...args) => {
    const agent = asAgent(args[0])
    const st = agent ? state.agents.get(agent) : undefined
    if (!st) return
    st.restriction?.()
    state.agents.delete(agent)
  })

  ctx.on('tools/change', () => {
    if (state.refreshTimer) clearTimeout(state.refreshTimer)
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null
      refreshAndClassify().catch((error) => log('refresh failed:', error?.message ?? error))
    }, 1_200)
    state.refreshTimer?.unref?.()
  })

  state.startupTimer = setTimeout(() => {
    state.startupTimer = null
    refreshAndClassify().catch((error) => log('startup classification failed:', error?.message ?? error))
  }, config.classifyDelayMs)
  state.startupTimer?.unref?.()

  log(`ready (catalog=${config.catalogPath}, categories=${state.catalog.categories.length})`)
}
