#!/bin/bash

# CGMB依存関係検証スクリプト
# このスクリプトは必要な依存関係とツールの存在を確認します

set -e

echo "🔍 CGMB依存関係検証スクリプト"
echo "================================"

# 色設定
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 成功・失敗カウンター
SUCCESS_COUNT=0
FAILURE_COUNT=0

# チェック関数
check_command() {
    local cmd=$1
    local name=$2
    
    if command -v "$cmd" &> /dev/null; then
        echo -e "${GREEN}✓${NC} $name が見つかりました: $(which $cmd)"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        return 0
    else
        echo -e "${RED}✗${NC} $name が見つかりません"
        FAILURE_COUNT=$((FAILURE_COUNT + 1))
        return 1
    fi
}

# agy バージョンチェック
# 1.1.7 未満は非TTY で何も出力せず exit 0 になるため、存在確認だけでは不十分。
MIN_AGY_VERSION="1.1.7"

# version_at_least ACTUAL MINIMUM -> ACTUAL >= MINIMUM のとき exit 0
#
# `sort -V` は GNU 拡張で、macOS 標準の BSD sort には存在しない。
# そちらでは比較結果が空になり、要件を満たすバージョンまで「古すぎる」と
# 誤判定される。awk は POSIX 必須なので macOS でも動作する。
version_at_least() {
    awk -v a="$1" -v b="$2" '
    BEGIN {
        gsub(/^[vV]/, "", a); gsub(/^[vV]/, "", b);
        na = split(a, A, "."); nb = split(b, B, ".");
        n = (na > nb) ? na : nb;
        for (i = 1; i <= n; i++) {
            x = (i <= na) ? A[i] + 0 : 0;
            y = (i <= nb) ? B[i] + 0 : 0;
            if (x != y) exit (x > y) ? 0 : 1;
        }
        exit 0;
    }'
}

check_agy_version() {
    if ! command -v agy &> /dev/null; then
        echo -e "${RED}✗${NC} Antigravity CLI (agy) が見つかりません"
        FAILURE_COUNT=$((FAILURE_COUNT + 1))
        return 1
    fi

    local agy_version
    agy_version=$(agy --version 2>/dev/null | head -n1 | tr -d '[:space:]')

    if [ -z "$agy_version" ]; then
        echo -e "${RED}✗${NC} agy のバージョンを取得できません"
        FAILURE_COUNT=$((FAILURE_COUNT + 1))
        return 1
    fi

    if version_at_least "$agy_version" "$MIN_AGY_VERSION"; then
        echo -e "${GREEN}✓${NC} Antigravity CLI (agy) $agy_version (要件: >=$MIN_AGY_VERSION)"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        return 0
    fi

    echo -e "${RED}✗${NC} Antigravity CLI $agy_version は古すぎます (要件: >=$MIN_AGY_VERSION)"
    echo -e "${YELLOW}  → agy update で更新してください${NC}"
    FAILURE_COUNT=$((FAILURE_COUNT + 1))
    return 1
}

# Node.js バージョンチェック
check_node_version() {
    if command -v node &> /dev/null; then
        local version=$(node --version)
        local major_version=$(echo $version | cut -d'.' -f1 | sed 's/v//')
        
        if [ "$major_version" -ge 22 ]; then
            echo -e "${GREEN}✓${NC} Node.js バージョン: $version (要件: >=22.0.0)"
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        else
            echo -e "${RED}✗${NC} Node.js バージョン: $version (要件: >=22.0.0)"
            echo -e "${YELLOW}  → nvm use 22 でバージョンを切り替えてください${NC}"
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
        fi
    else
        echo -e "${RED}✗${NC} Node.js が見つかりません"
        FAILURE_COUNT=$((FAILURE_COUNT + 1))
    fi
}

# 必須ツールチェック
echo "📋 必須ツールの確認:"
check_node_version
check_command "npm" "NPM"
check_command "claude" "Claude Code CLI"
check_agy_version

echo ""

# プロジェクト構造チェック
echo "📁 プロジェクト構造の確認:"

PROJECT_FILES=(
    "package.json"
    "tsconfig.json"
    "src/index.ts"
    "src/cli.ts"
    "src/core/CGMBServer.ts"
    "dist/cli.js"
    "dist/index.js"
)

for file in "${PROJECT_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $file"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
        echo -e "${RED}✗${NC} $file が見つかりません"
        FAILURE_COUNT=$((FAILURE_COUNT + 1))
    fi
done

echo ""

# 環境変数チェック
echo "🔑 環境変数の確認:"

ENV_VARS=(
    "AI_STUDIO_API_KEY"
)

for var in "${ENV_VARS[@]}"; do
    if [ -n "${!var}" ]; then
        echo -e "${GREEN}✓${NC} $var は設定されています"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
        echo -e "${YELLOW}⚠${NC} $var が設定されていません"
        echo -e "   → .envファイルで設定してください"
    fi
done

echo ""

# NPM依存関係チェック
echo "📦 NPM依存関係の確認:"

if [ -f "package.json" ] && [ -d "node_modules" ]; then
    echo -e "${GREEN}✓${NC} node_modules が存在します"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    
    # 主要依存関係の確認
    REQUIRED_DEPS=(
        "@modelcontextprotocol/sdk"
        "commander"
        "winston"
        "zod"
    )
    
    for dep in "${REQUIRED_DEPS[@]}"; do
        if [ -d "node_modules/$dep" ]; then
            echo -e "${GREEN}✓${NC} $dep"
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        else
            echo -e "${RED}✗${NC} $dep が見つかりません"
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
        fi
    done
else
    echo -e "${RED}✗${NC} node_modules が見つかりません"
    echo -e "   → npm install を実行してください"
    FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

echo ""

# Claude Code MCP設定チェック
echo "🔗 Claude Code MCP設定の確認:"

MCP_CONFIG_PATH="$HOME/.claude-code/mcp_servers.json"

if [ -f "$MCP_CONFIG_PATH" ]; then
    echo -e "${GREEN}✓${NC} MCP設定ファイルが存在します: $MCP_CONFIG_PATH"
    
    if grep -q "claude-gemini-multimodal-bridge" "$MCP_CONFIG_PATH"; then
        echo -e "${GREEN}✓${NC} CGMB MCP設定が見つかりました"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
        echo -e "${YELLOW}⚠${NC} CGMB MCP設定が見つかりません"
        echo -e "   → cgmb setup-mcp を実行してください"
    fi
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
else
    echo -e "${YELLOW}⚠${NC} MCP設定ファイルが見つかりません: $MCP_CONFIG_PATH"
    echo -e "   → Claude Codeを一度起動してからcgmb setup-mcpを実行してください"
fi

echo ""

# 結果サマリー
echo "📊 検証結果サマリー:"
echo "================================"
echo -e "${GREEN}成功: $SUCCESS_COUNT${NC}"
echo -e "${RED}失敗: $FAILURE_COUNT${NC}"

if [ $FAILURE_COUNT -eq 0 ]; then
    echo -e "${GREEN}🎉 全ての依存関係チェックが成功しました！${NC}"
    echo "CGMB is ready to use!"
    exit 0
else
    echo -e "${YELLOW}⚠️  いくつかの問題が見つかりました。${NC}"
    echo ""
    echo "🔧 推奨アクション:"
    echo "1. 不足している依存関係をインストール"
    echo "2. 環境変数を.envファイルで設定"
    echo "3. cgmb setup を実行"
    echo "4. cgmb verify を実行して最終確認"
    exit 1
fi