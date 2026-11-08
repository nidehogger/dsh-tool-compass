# 发布清单

## 为什么需要你操作

插件已经打好包、测试通过，但真正上传需要两个账号动作，这台机器上没有对应凭据：

- `npm whoami` 返回 `ENEEDAUTH`（没有登录 npm）；
- 没有 `gh` CLI，也没有 GitHub 私钥（`~/.ssh` 里只有 `authorized_keys`），无法创建仓库或提 PR。

另外，`dsh-tool-router` 这个 npm 名已被他人占用（nzl153，0.1.0），所以改名为 **`dsh-tool-compass`**（已确认 npm 上可用）。

## 1. 建 GitHub 仓库并推送

```bash
cd /mnt/data/dsh-tool-compass
git init -b main
git add .
git commit -m "feat: model-classified tool compass for DSH"
# 先在 github.com 新建空仓库 dsh-tool-compass，然后：
git remote add origin git@github.com:<你的账号>/dsh-tool-compass.git
git push -u origin main
```

要求：仓库创建满 1 天、加上 `dsh-plugin` topic、根目录 `package.json` 里有 `dsh.bundle`（已满足）。

## 2. 登录 npm 并发布

```bash
npm login          # 浏览器/OTP 登录，不要把 token 贴到对话里
cd /mnt/data/dsh-tool-compass
npm publish
```

发布前可先验证内容：

```bash
npm pack --dry-run
npm publish --dry-run
```

发布后把 `repository` 字段补上再 `npm version patch && npm publish`（npm 与市场条目的仓库关联依赖这个字段）：

```json
"repository": { "type": "git", "url": "git+https://github.com/<你的账号>/dsh-tool-compass.git" }
```

## 3. 提交插件市场

市场（awesome-dsh-plugin）收录方式是向仓库提 PR，新增 **一个** 文件：

`data/plugins/<owner>__dsh-tool-compass.yml`

```yaml
url: https://github.com/<owner>/dsh-tool-compass
name: <owner>/dsh-tool-compass
category: tools
description:
  en: Model-classified tool catalog for DeepSeek Harness: the agent sees functional categories and pulls specific tools on demand.
  zh: 模型自动分类的工具罗盘：模型默认只看到功能类别，需要时检索并展开具体工具。
```

PR 仓库：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`

## 4. 安装验证

```bash
dsh plugin --profile web add dsh-tool-compass   # npm 发布后
# 或
dsh plugin --profile web add link:/mnt/data/dsh-tool-compass
```

重启后：`tool_catalog` 应返回分类；`tool_router_status` 应显示“已登记 / 可见 / 已分类”三个数。
