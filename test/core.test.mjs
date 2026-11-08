import test from 'node:test'
import assert from 'node:assert/strict'

import {
  tokenize,
  searchItems,
  renderCatalog,
  normalizeCategories,
} from '../lib/catalog.js'
import {
  parseClassification,
  mergeClassification,
  heuristicCategories,
  buildClassificationPrompt,
} from '../lib/classify.js'

test('tokenize 支持中文 bigram 与英文单词', () => {
  const tokens = tokenize('发送 邮件 email')
  assert.ok(tokens.includes('发送'))
  assert.ok(tokens.includes('邮件'))
  assert.ok(tokens.includes('email'))
})

test('searchItems 优先命中名称与描述', () => {
  const items = [
    { kind: 'tool', name: 'mail_send', description: '发送邮件给收件人', category: '沟通与邮件' },
    { kind: 'tool', name: 'bash', description: '运行 shell 命令', category: '系统与文件' },
    { kind: 'skill', name: 'kb-search', description: '检索本地知识库', category: '文档与知识库' },
  ]
  const hits = searchItems(items, '发邮件', 3)
  assert.equal(hits[0].name, 'mail_send')
  assert.ok(hits.every((hit) => hit.score > 0))
})

test('searchItems 无命中返回空数组', () => {
  const hits = searchItems([{ kind: 'tool', name: 'bash', description: 'shell', category: '系统' }], '量子计算', 5)
  assert.deepEqual(hits, [])
})

test('renderCatalog 只显示类别与数量，不列工具名', () => {
  const catalog = {
    categories: [
      { name: '文档与知识库', description: '检索本地资料', tools: ['kb_search'], skills: ['kb-search'] },
      { name: '系统与文件', description: '命令行与文件', tools: ['bash', 'read'], skills: [] },
    ],
  }
  const text = renderCatalog(catalog, { totalTools: 3, totalSkills: 1 })
  assert.match(text, /文档与知识库/)
  assert.match(text, /2 个工具/)
  assert.ok(!text.includes('kb_search'), '不应列出具体工具名')
  assert.match(text, /tool_search/)
})

test('parseClassification 校验覆盖并报告缺失', () => {
  const items = [
    { kind: 'tool', name: 'a', description: '' },
    { kind: 'tool', name: 'b', description: '' },
    { kind: 'skill', name: 'c', description: '' },
  ]
  const text = '```json\n{"categories":[{"name":"甲","description":"x","members":["tool:a","skill:c"]}]}\n```'
  const result = parseClassification(text, items)
  assert.equal(result.categories.length, 1)
  assert.deepEqual(result.missing, ['tool:b'])
})

test('mergeClassification 合并旧类别并接住遗漏项', () => {
  const catalog = {
    version: 1,
    updatedAt: null,
    model: '',
    categories: [{ name: '甲', description: '旧描述', tools: ['a'], skills: [] }],
  }
  const items = [
    { kind: 'tool', name: 'a', description: '' },
    { kind: 'tool', name: 'b', description: '' },
  ]
  const merged = mergeClassification(
    catalog,
    [{ name: '甲', description: '新描述', tools: ['b'], skills: [] }],
    items,
    '未分类',
  )
  const a = merged.categories.find((category) => category.name === '甲')
  assert.deepEqual(a.tools.sort(), ['a', 'b'])
})

test('heuristicCategories 在无模型时兜底', () => {
  const categories = heuristicCategories([
    { kind: 'tool', name: 'web_search', description: '联网搜索' },
    { kind: 'skill', name: 'kb-search', description: '知识库检索' },
  ])
  const names = categories.map((category) => category.name)
  assert.ok(names.length >= 1)
  assert.ok(categories.some((category) => category.tools.length + category.skills.length > 0))
})

test('buildClassificationPrompt 包含规则与待分类条目', () => {
  const prompt = buildClassificationPrompt(
    [{ kind: 'tool', name: 'mail_send', description: '发送邮件' }],
    [],
  )
  assert.match(prompt.user, /mail_send/)
  assert.match(prompt.user, /每个条目必须且只能出现在一个类别里/)
  assert.match(prompt.system, /JSON/)
})
