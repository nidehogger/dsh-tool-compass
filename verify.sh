#!/usr/bin/env bash
# 重启后自检：目录规模、插件安装状态、web profile 组合。
set -u
CATALOG="${CATALOG:-$HOME/.dsh/tool-compass.json}"
PROFILE="${PROFILE:-$HOME/.dsh/profiles/web}"
echo "== 目录文件 =="
python3 - "$CATALOG" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as exc:
    print("读取失败:", exc); raise SystemExit(1)
tools = sum(len(c.get('tools', [])) for c in d.get('categories', []))
skills = sum(len(c.get('skills', [])) for c in d.get('categories', []))
print(f"更新: {d.get('updatedAt')}  模型: {d.get('model')}")
print(f"类别: {len(d.get('categories', []))}  工具: {tools}  技能: {skills}")
for c in d.get('categories', []):
    print(f"  - {c['name']}  ({len(c.get('tools', []))} tools, {len(c.get('skills', []))} skills)")
PY
echo
echo "== 插件安装 =="
python3 - "$PROFILE" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
pkg = json.load(open(p / 'package.json'))
print("dependency:", pkg.get('dependencies', {}).get('dsh-tool-compass', '缺失'))
bundles = (pkg.get('dsh', {}).get('profile', {}) or {}).get('bundles', [])
print("bundle:", "已注册" if 'dsh-tool-compass' in bundles else "缺失")
PY
echo
echo "== 重启后检查 =="
echo "在对话里调用 tool_catalog / tool_router_status；预期工具数接近 54（当前依赖面）。"
echo "若明显偏少：调用 tool_router_refresh(mode=\"all\") 再查一次。"
