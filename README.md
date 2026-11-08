# dsh-tool-compass

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供的**工具罗盘**：
模型默认只看到“工具类别目录”，需要具体能力时用 `tool_search` 检索，检索命中的工具才会展开到当前会话。

它解决的是每轮请求里**工具 schema 占用上下文**的问题。与手写分组不同，分类由默认模型完成：

1. **首次分类**：插件加载后调用一次默认模型，把当前全部 tools + skills 按“用户任务场景”归类，写入 `~/.dsh/tool-compass.json`；
2. **增量分类**：监听 `tools/change`，有新工具时再次调用模型，只归类新增项并合并进已有类别；
3. **手动重建**：`tool_router_refresh` 工具，`new` 增量 / `all` 全量；
4. 模型不可用或输出不合法时退化为关键词归类，保证插件永远可用（fail-open）。

## 模型看到什么

- 系统提示中只有**类别名、描述、数量**，不列具体工具名；
- 默认常开：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`web_search`、`web_fetch`、`todo_write`、`skill`、`ask_user_question`、`present`，加上四个路由工具；
- 其余工具默认隐藏，调用会得到 `UNKNOWN_TOOL`，需要先 `tool_search`。

## 工具

| 工具 | 作用 |
|---|---|
| `tool_search(query, limit?)` | 按名称/描述/类别检索；命中的工具对当前会话开放（下一步生效），技能返回后用 `skill` 加载 |
| `tool_catalog()` | 查看类别目录 |
| `tool_router_refresh(mode?)` | `new` 增量、`all` 清空重建 |
| `tool_router_status()` | 查看“目录分类 / 已登记 / 当前可见”三个数，并提示是否需要重建 |

开放状态按 Agent 会话隔离，不跨重启持久化；重启后重新检索即可。

## 安装

要求 DSH `>= 0.2.2-rc.1`、Node.js 20+。

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-tool-compass
# 本地目录
dsh plugin --profile web add link:/path/to/dsh-tool-compass
```

安装后重启一次 DSH。确认：

```bash
python3 -c "import json;d=json.load(open('$HOME/.dsh/tool-compass.json'));print(len(d['categories']),sum(len(c['tools']) for c in d['categories']),sum(len(c['skills']) for c in d['categories']))"
```

对话里调用 `tool_catalog` 或 `tool_router_status`。

## 配置

```yaml
- id: tool-compass
  name: 'dsh-tool-compass'
  config:
    enabled: true
    classifyOnStart: true
    classifyOnChange: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后不注册工具、不隐藏工具 |
| `catalogPath` | `~/.dsh/tool-compass.json` | 分类目录文件 |
| `classifyOnStart` | `true` | 启动后自动分类（目录为空则全量，否则增量） |
| `classifyOnChange` | `true` | 工具变化时自动增量分类 |
| `classifyDelayMs` | `4000` | 启动后等待工具注册完成再分类 |
| `searchLimit` | `6` | 单次检索返回条数上限 |
| `alwaysVisible` | 核心工具列表 | 始终对模型可见的工具名 |

## 行为细节

- 分类变更只改写目录文件与系统提示，不改变工具注册；
- 检索开放只影响调用它的 Agent 会话，子代理/其他会话不继承；
- 任何一步失败都 fail-open：恢复原工具可见性，不影响正常使用；
- 目录变化会使该前缀的 prompt cache 失效一次。

## 已知限制

- 首次分类依赖默认模型；`agentDefaultModel` 不可用时走关键词兜底，类别会变粗；
- 重启后需重新检索（开放状态不持久化）；
- 工具被隐藏时无法直接调用，这是预期行为；
- 热重载/反复启停可能留下旧的可见性限制，重启 DSH 可清空；`tool_router_status` 会提示“目录少于已登记工具”。

## 开发

```bash
node --test test/*.test.mjs
./verify.sh
```

## License

MIT
