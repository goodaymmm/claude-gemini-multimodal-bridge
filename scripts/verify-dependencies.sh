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
check_command "gemini" "Gemini CLI"

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
    "GEMINI_API_KEY"
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