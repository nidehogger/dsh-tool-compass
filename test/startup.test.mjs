import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../index.js'

function harness(schemas) {
  const registered = new Map()
  const handlers = new Map()
  const restrictions = []

  const tools = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => {}
    },
    schemas() {
      return schemas
    },
    restrict(filter) {
      restrictions.push(filter)
      return () => {}
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
      if (service === 'skills') return { list: async () => [] }
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
      }
      if (service === 'llm') {
        return {
          async *stream({ messages }) {
            const text = messages?.[0]?.content?.[0]?.text ?? ''
            const members = [...text.matchAll(/- (tool|skill):([A-Za-z0-9_\-\u3400-\u9fff]+)/g)]
              .map((match) => `${match[1]}:${match[2]}`)
            const mid = Math.ceil(members.length / 2)
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                categories: [
                  { name: '既有类别', description: '复用', members: members.slice(0, mid) },
                  { name: '新增类别', description: '新增', members: members.slice(mid) },
                ],
              }),
            }
          },
        }
      }
      return undefined
    },
    systemPrompt: { section() { return () => {} } },
  }
  return { ctx, registered, handlers, restrictions }
}

test('启动时把目录里缺失的工具增量归类进去', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-router-startup-'))
  const catalogPath = join(dir, 'catalog.json')
  writeFileSync(catalogPath, JSON.stringify({
    version: 1,
    updatedAt: null,
    model: 'old',
    categories: [
      { name: '既有类别', description: '旧', tools: ['a', 'b'], skills: [] },
      { name: '其他', description: '旧', tools: ['c'], skills: [] },
    ],
  }))

  try {
    const schemas = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => ({
      name,
      description: `工具 ${name}`,
    }))
    const h = harness(schemas)
    apply(h.ctx, {
      catalogPath,
      alwaysVisible: ['a'],
      classifyOnStart: true,
      classifyOnChange: false,
      classifyDelayMs: 50,
    })

    const agent = {
      ctx: {
        get(service) {
          if (service === 'tools') return h.ctx.tools
          return undefined
        },
      },
    }
    for (const handler of h.handlers.get('agent/created') ?? []) handler({ agent })

    await new Promise((resolve) => setTimeout(resolve, 1200))
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
    const names = catalog.categories.flatMap((category) => category.tools)
    assert.equal(new Set(names).size, 8, `应包含全部 8 个工具，实际 ${names.join(',')}`)
    assert.ok(catalog.categories.some((category) => category.name === '新增类别'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
