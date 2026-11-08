import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../index.js'

function makeHarness(schemas) {
  const registered = new Map()
  const handlers = new Map()
  const restrictions = []
  const sections = []
  const disposals = []

  const tools = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    schemas() {
      return schemas
    },
    restrict(filter) {
      restrictions.push(filter)
      return () => disposals.push(filter)
    },
  }

  const ctx = {
    tools,
    effect(fn) {
      return fn()
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    get(service) {
      if (service === 'agents') return { list: () => [] }
      if (service === 'skills') return { list: async () => [{ name: 'kb-search', description: '检索本地知识库' }] }
      return undefined
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
  }
  return { ctx, registered, handlers, restrictions, sections, disposals }
}

test('插件注册检索工具、注入目录、按 agent 隐藏未开放工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-router-'))
  const catalogPath = join(dir, 'catalog.json')
  writeFileSync(catalogPath, JSON.stringify({
    version: 1,
    updatedAt: null,
    model: 'test',
    categories: [
      { name: '沟通与邮件', description: '发邮件', tools: ['mail_send'], skills: [] },
      { name: '系统与文件', description: '命令行', tools: ['bash', 'tool_search'], skills: [] },
    ],
  }))

  try {
    const schemas = [
      { name: 'bash', description: '运行 shell 命令' },
      { name: 'mail_send', description: '发送邮件给收件人' },
      { name: 'tool_search', description: '检索工具' },
      { name: 'tool_catalog', description: '查看目录' },
    ]
    const harness = makeHarness(schemas)
    apply(harness.ctx, {
      catalogPath,
      alwaysVisible: ['bash'],
      classifyOnStart: false,
      classifyOnChange: false,
      classifyDelayMs: 60_000,
    })

    assert.ok(harness.registered.has('tool_search'))
    assert.ok(harness.registered.has('tool_catalog'))
    assert.equal(harness.sections.length, 1)

    const agent = {
      ctx: {
        get(service) {
          if (service === 'tools') return harness.ctx.tools
          return undefined
        },
      },
    }
    for (const handler of harness.handlers.get('agent/created') ?? []) handler({ agent })

    assert.equal(harness.restrictions.length, 1)
    assert.deepEqual(harness.restrictions[0].deny, ['mail_send'])

    const search = harness.registered.get('tool_search')
    const result = await search.execute({ query: '发送邮件' }, { agent })
    assert.equal(result.ok, true)
    assert.ok(result.opened.includes('mail_send'))
    assert.match(result.message, /已开放/)
    assert.equal(harness.disposals.length, 1, '检索后应解除旧限制并重新计算')

    const catalogTool = harness.registered.get('tool_catalog')
    const catalogResult = await catalogTool.execute({}, { agent })
    assert.match(catalogResult.message, /沟通与邮件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
