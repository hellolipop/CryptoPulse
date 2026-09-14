#!/bin/bash
# GitHub 自动推送脚本
# 使用方法: ./push.sh "提交信息"

cd "$(dirname "$0")"

# 检查是否有变更
if git diff --quiet && git diff --cached --quiet; then
    echo "没有需要提交的变更"
    exit 0
fi

# 添加所有变更
git add -A

# 提交
COMMIT_MSG="${1:-update: 更新代码}"
git commit -m "$COMMIT_MSG"

# 推送到远程
git push origin main

if [ $? -eq 0 ]; then
    echo "✅ 推送成功！"
else
    echo "❌ 推送失败，请检查 GitHub 认证"
    echo "提示: 运行 gh auth login 或设置 GH_TOKEN 环境变量"
fi
