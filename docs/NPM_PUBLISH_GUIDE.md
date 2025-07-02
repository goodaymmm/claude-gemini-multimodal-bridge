# NPM Publishing Guide / NPM公開ガイド

This guide provides comprehensive instructions for publishing the Claude-Gemini Multimodal Bridge to NPM.

このガイドでは、Claude-Gemini Multimodal BridgeをNPMに公開するための包括的な手順を説明します。

## Prerequisites / 前提条件

1. **NPM Account / NPMアカウント**
   - Create an account at https://www.npmjs.com/ if you don't have one
   - NPMアカウントを持っていない場合は、https://www.npmjs.com/ で作成してください

2. **Node.js & NPM**
   - Node.js >= 22.0.0
   - NPM >= 8.0.0

3. **Git Repository**
   - All changes committed and pushed
   - すべての変更がコミットされ、プッシュされていること

## Step-by-Step Publishing Process / 公開手順

### 1. Check NPM Login / NPMログイン確認

```bash
# Check if you're logged in / ログイン状態を確認
npm whoami

# If not logged in, login / ログインしていない場合
npm login
```

### 2. Verify Package Name Availability / パッケージ名の利用可能性確認

```bash
# Should return 404 (not found) / 404エラーが返ることを確認
npm view claude-gemini-multimodal-bridge
```

### 3. Create .npmignore File / .npmignoreファイルの作成

Create `.npmignore` to exclude unnecessary files from the package:

```
# Source files
src/
*.ts
!*.d.ts

# Config files
.env
.env.*
.env.example

# Development files
tests/
coverage/
.vscode/
.idea/
*.log
npm-debug.log*

# Git
.git/
.gitignore
.github/

# Documentation (optional)
docs/
*.md
!README.md
!LICENSE

# Build tools
.eslintrc*
.prettierrc*
tsconfig.json
webpack.config.js

# OS files
.DS_Store
Thumbs.db

# Temporary files
*.tmp
*.temp
```

### 4. Update package.json / package.jsonの更新

Add the following fields to package.json:

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/goodaymmm/claude-gemini-multimodal-bridge.git"
  },
  "bugs": {
    "url": "https://github.com/goodaymmm/claude-gemini-multimodal-bridge/issues"
  },
  "homepage": "https://github.com/goodaymmm/claude-gemini-multimodal-bridge#readme",
  "engines": {
    "node": ">=22.0.0",
    "npm": ">=8.0.0"
  },
  "files": [
    "dist/",
    "scripts/postinstall.cjs",
    "README.md",
    "LICENSE",
    "package.json"
  ],
  "publishConfig": {
    "access": "public"
  }
}
```

### 5. Add Publishing Scripts / 公開用スクリプトの追加

Add to package.json scripts:

```json
{
  "scripts": {
    "prepublishOnly": "npm run lint && npm run typecheck && npm run build",
    "preversion": "npm run lint && npm run typecheck",
    "version": "npm run build && git add -A dist",
    "postversion": "git push && git push --tags"
  }
}
```

### 6. Final Build and Test / 最終ビルドとテスト

```bash
# Clean build / クリーンビルド
npm run clean
npm run build

# Run tests if available / テストがある場合は実行
npm test

# Check what will be published / 公開される内容を確認
npm publish --dry-run
```

### 7. Publish to NPM / NPMへの公開

```bash
# For first-time publishing / 初回公開の場合
npm publish --access public

# For updates, increment version first / 更新の場合は、まずバージョンを上げる
npm version patch  # or minor/major
npm publish
```

## Version Management / バージョン管理

- **patch** (1.1.0 → 1.1.1): Bug fixes / バグ修正
- **minor** (1.1.0 → 1.2.0): New features (backward compatible) / 新機能（後方互換性あり）
- **major** (1.1.0 → 2.0.0): Breaking changes / 破壊的変更

## Post-Publishing Checklist / 公開後のチェックリスト

1. **Verify Installation / インストール確認**
   ```bash
   npm install -g claude-gemini-multimodal-bridge
   cgmb --version
   ```

2. **Update README / READMEの更新**
   - Add NPM badge / NPMバッジを追加
   - Update installation instructions / インストール手順を更新

3. **Create GitHub Release / GitHubリリースの作成**
   - Tag the version / バージョンにタグを付ける
   - Add release notes / リリースノートを追加

4. **Update Claude Code MCP Registry (if applicable)**
   - Submit PR to MCP registry / MCPレジストリにPRを提出

## Troubleshooting / トラブルシューティング

### Common Issues / よくある問題

1. **E403 Forbidden**
   - Not logged in or no publish permissions
   - ログインしていないか、公開権限がない
   ```bash
   npm login
   ```

2. **E409 Conflict**
   - Version already exists / バージョンが既に存在
   ```bash
   npm version patch
   npm publish
   ```

3. **Files Missing in Package**
   - Check .npmignore and "files" in package.json
   - .npmignoreとpackage.jsonの"files"を確認

4. **Build Errors**
   - Ensure all TypeScript compiles / TypeScriptがコンパイルされることを確認
   ```bash
   npm run typecheck
   npm run build
   ```

## Security Checklist / セキュリティチェックリスト

Before publishing, ensure: / 公開前に確認：

- [ ] No API keys in code / コードにAPIキーが含まれていない
- [ ] No .env files included / .envファイルが含まれていない
- [ ] No sensitive data in package / パッケージに機密データが含まれていない
- [ ] Dependencies are up to date / 依存関係が最新
- [ ] No vulnerable dependencies / 脆弱性のある依存関係がない

```bash
# Check for vulnerabilities / 脆弱性をチェック
npm audit
npm audit fix
```

## Maintenance / メンテナンス

### Regular Updates / 定期的な更新

1. Keep dependencies updated / 依存関係を最新に保つ
   ```bash
   npm update
   npm outdated
   ```

2. Monitor security advisories / セキュリティアドバイザリを監視
   ```bash
   npm audit
   ```

3. Respond to issues promptly / イシューに迅速に対応

### Deprecation Process / 非推奨化プロセス

If deprecating versions: / バージョンを非推奨にする場合：

```bash
npm deprecate claude-gemini-multimodal-bridge@"< 1.0.0" "Please upgrade to 1.1.0 or higher"
```

## Additional Resources / 追加リソース

- [NPM Documentation](https://docs.npmjs.com/)
- [Semantic Versioning](https://semver.org/)
- [NPM Best Practices](https://docs.npmjs.com/misc/developers)
- [Publishing Scoped Packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)

---

Last updated: 2025-01-02