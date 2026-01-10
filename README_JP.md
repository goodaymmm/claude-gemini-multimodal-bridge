<div align="center">

# 🌉 Claude-Gemini Multimodal Bridge

### *AIの力を、ひとつに。*

**Claude Code、Gemini CLI、Google AI Studioをシームレスに統合するMCPブリッジ**

[🇺🇸 English](README.md) • [📦 NPM](https://www.npmjs.com/package/claude-gemini-multimodal-bridge) • [🐛 Issues](https://github.com/goodaymmm/claude-gemini-multimodal-bridge/issues)

---

[![npm version](https://img.shields.io/npm/v/claude-gemini-multimodal-bridge?style=flat-square&color=CB3837&logo=npm)](https://www.npmjs.com/package/claude-gemini-multimodal-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-00D4AA?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkw0IDdWMTdMN10gMjJWMTJMMTcgN1YxN0wxMiAyMlYxMkw3IDdWMTdMMTIgMjJMNy4gMTdWN0wxMiAyWiIgZmlsbD0id2hpdGUiLz48L3N2Zz4=)](https://modelcontextprotocol.io/)
[![Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=flat-square&logo=google-gemini&logoColor=white)](https://ai.google.dev/)
[![Claude](https://img.shields.io/badge/Claude-191919?style=flat-square&logo=anthropic&logoColor=white)](https://www.anthropic.com/)

[![Windows](https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white)](#-windows環境)
[![macOS](https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white)](#-クイックスタート)
[![Linux](https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black)](#-クイックスタート)

</div>

---

## 🤔 なぜ CGMB？

<table>
<tr>
<td width="33%" align="center">

### 🔄 統合の力

Claude Code の**推論力**、Gemini CLI の**検索力**、AI Studio の**生成力**を自動で使い分け

</td>
<td width="33%" align="center">

### ⚡ ゼロ設定

`npm install` 一発で完了。面倒な設定は自動化

</td>
<td width="33%" align="center">

### 🎯 日本語ネイティブ

日本語プロンプトを自動翻訳。自然に使える

</td>
</tr>
</table>

---

## ✨ v1.1.0 の新機能

| 機能 | 説明 |
|------|------|
| 🪟 **Windows完全対応** | CLI/MCP両方でネイティブサポート |
| 📝 **OCR処理強化** | スキャンPDFの自動テキスト抽出 |
| 🚀 **最新Geminiモデル** | `gemini-2.5-flash`, `gemini-3-flash` 対応 |
| 🔐 **OAuth認証** | Claude Code互換のファイルベース認証 |
| 🌐 **自動翻訳** | 画像生成時の日本語→英語翻訳 |
| 📊 **スマートルーティング** | PDF URLはAI Studioへ、WebページはGemini CLIへ |
| ⚡ **パフォーマンス最適化** | タイムアウト短縮、遅延読み込み、キャッシング |
| 🛡️ **エラー回復** | 指数バックオフによる95%の自己修復 |

---

## 🏗️ アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                      あなたの Claude Code                    │
└─────────────────────────┬───────────────────────────────────┘
                          │ "CGMB" キーワード
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    🌉 CGMB (MCP Bridge)                      │
│                   インテリジェントルーティング                 │
└───────────┬─────────────────┬─────────────────┬─────────────┘
            │                 │                 │
            ▼                 ▼                 ▼
     ┌──────────┐      ┌──────────┐      ┌──────────┐
     │ 🔍 Gemini │      │ 🧠 Claude │      │ 🎨 AI    │
     │   CLI    │      │   Code   │      │  Studio  │
     └──────────┘      └──────────┘      └──────────┘
     Web検索・最新情報   複雑な推論      画像・音声・OCR
```

| レイヤー | 得意分野 | タイムアウト |
|:--------:|:---------|:-----------:|
| 🔍 Gemini CLI | Web検索、リアルタイム情報 | 30秒 |
| 🧠 Claude Code | 複雑な推論、コード分析 | 300秒 |
| 🎨 AI Studio | 画像生成、音声合成、OCR | 120秒 |

---

## 🚀 クイックスタート

### 📋 前提条件

- **Node.js** ≥ 22.0.0
- **Claude Code CLI** インストール済み
- **Gemini CLI** (自動インストール)

### 📦 インストール

```bash
npm install -g claude-gemini-multimodal-bridge
```

> 💡 postinstallスクリプトが自動で:
> - Gemini CLI をインストール
> - Claude Code MCP統合をセットアップ
> - `.env` テンプレートを作成
> - システム要件を検証

### 🔑 環境設定

作業ディレクトリに `.env` ファイルを作成:

```bash
AI_STUDIO_API_KEY=your_api_key_here
```

🔗 APIキー取得: https://aistudio.google.com/app/apikey

### 🎯 Gemini CLI 認証

```bash
gemini
```

### 💬 Claude Code で使い始める

```
NPMでCGMBをインストールしたので、今の環境からcgmbコマンドを探してください。使い方も教えてください。
```

---

## 💡 使用例

CGMBはClaude Codeとシームレスに統合。**「CGMB」キーワード**を使うだけ:

```bash
# 🎨 画像生成
"CGMBで未来都市のイメージを生成してください"

# 📄 ドキュメント分析（絶対パスを使用）
"CGMBで/full/path/to/report.pdfにあるこの文書を分析してください"

# 🌐 URL分析
"CGMBでhttps://example.com/document.pdfを分析してください"

# 🔍 Web検索
"CGMBで最新のAI情報を検索してください"

# 🎵 音声生成
"CGMBで「ポッドキャストへようこそ」という音声を作成してください"

# 📝 OCR対応PDF解析
"CGMBでこのスキャンされたPDF文書をOCRで解析してください"
```

### 🔄 自動ルーティング

1. Claude Code リクエストに **「CGMB」** を含める
2. CGMB が最適な AI レイヤーに自動ルーティング:
   - **🔍 Gemini CLI**: Web検索、最新情報
   - **🎨 AI Studio**: 画像、音声、ファイル処理
   - **🧠 Claude Code**: 複雑な推論、コード分析

---

## 🤖 使用モデル一覧

| 用途 | モデルID | レイヤー |
|:----:|:---------|:-------:|
| 🔍 Web検索 | `gemini-3-flash` | Gemini CLI |
| 🎨 画像生成 | `gemini-2.5-flash-image` | AI Studio |
| 🎵 音声生成 | `gemini-2.5-flash-preview-tts` | AI Studio |
| 📄 ドキュメント処理 | `gemini-2.5-flash` | AI Studio |
| 📝 OCR/テキスト抽出 | `gemini-2.5-flash` | AI Studio |
| 🔮 汎用マルチモーダル | `gemini-2.0-flash-exp` | AI Studio |

---

## 📈 パフォーマンス

<table>
<tr>
<td align="center">

### 80%
認証オーバーヘッド削減

</td>
<td align="center">

### 60-80%
検索キャッシュヒット率

</td>
<td align="center">

### 95%
エラー自動回復率

</td>
</tr>
</table>

---

## 📄 PDF処理 & OCR

### ✨ OCR機能

- ✅ テキストベースとスキャンPDF両対応
- ✅ OCR必要性を自動検出
- ✅ Gemini File APIでネイティブOCR処理
- ✅ 多言語サポート

### 📋 処理ワークフロー

```
PDF入力 → アップロード → OCR処理 → コンテンツ分析 → 結果出力
```

### 📁 サポート形式

- テキストベースPDF
- スキャンPDF（OCR処理）
- 画像ベースPDF（OCR変換）
- 混合コンテンツ
- 複雑なレイアウト（表、グラフ、フォーマット済みコンテンツ）

---

## 📂 ファイル構成

生成されたコンテンツは自動的に整理:

```
output/
├── images/     # 🎨 生成された画像
├── audio/      # 🎵 生成された音声ファイル
└── documents/  # 📄 処理されたドキュメント
```

Claude Code経由でアクセス:
- `get_generated_file`: 特定のファイルを取得
- `list_generated_files`: すべての生成ファイルをリスト
- `get_file_info`: ファイルメタデータを取得

---

## 🔧 設定

### 環境変数

```bash
# 必須
AI_STUDIO_API_KEY=your_api_key_here

# オプション
GEMINI_API_KEY=your_api_key_here
ENABLE_CACHING=true
CACHE_TTL=3600
LOG_LEVEL=info
```

### MCP統合

CGMBは自動的にClaude Code MCP統合を設定:
- 📍 設定パス: `~/.claude-code/mcp_servers.json`
- ⚡ 直接Node.js実行
- 🔒 既存サーバーを上書きしない安全なマージ

---

## 🪟 Windows環境

CGMBはv1.1.0でWindows環境を**完全サポート**:

| 機能 | 状態 |
|------|:----:|
| CLI | ✅ すべてのコマンドが動作 |
| MCP統合 | ✅ MCPツール呼び出しが正常動作 |
| パス解決 | ✅ `C:\path\to\file` 形式を自動処理 |
| Gemini CLI | ✅ Windows版との完全な互換性 |

```powershell
# パスは絶対パスを推奨
cgmb analyze "C:\Users\name\Documents\report.pdf"

# 環境変数の設定（PowerShell）
$env:AI_STUDIO_API_KEY = "your_api_key_here"

# 環境変数の設定（コマンドプロンプト）
set AI_STUDIO_API_KEY=your_api_key_here
```

---

## 🔍 トラブルシューティング

### デバッグモード

```bash
export CGMB_DEBUG=true
export LOG_LEVEL=debug
cgmb serve --debug
```

### OCRとPDF処理の問題

**OCR結果が不正確な場合:**
- 高解像度スキャンPDF（300+ DPI）を使用
- 明瞭で高コントラストなテキストを確保
- 傾きや回転した文書を避ける

**大きな文書でタイムアウトする場合:**
- 処理前に大きなPDFを分割（制限: 50MB、1,000ページ）
- タイムアウトを延長: `export AI_STUDIO_TIMEOUT=180000`

---

## 💰 APIコスト

CGMBは従量課金制APIを使用:
- 📊 [Google AI Studio API 料金詳細](https://ai.google.dev/pricing)

---

## 📁 プロジェクト構造

```
src/
├── core/           # 🎯 メインMCPサーバーとレイヤー管理
├── layers/         # 🔌 AIレイヤー実装
├── auth/           # 🔐 認証システム
├── tools/          # 🛠️ 処理ツール
├── workflows/      # 📋 ワークフロー実装
├── utils/          # 🔧 ユーティリティとヘルパー
└── mcp-servers/    # 🌐 カスタムMCPサーバー
```

---

## 🔗 リンク

<table>
<tr>
<td>

### 📦 プロジェクト
- [GitHub](https://github.com/goodaymmm/claude-gemini-multimodal-bridge)
- [NPM](https://www.npmjs.com/package/claude-gemini-multimodal-bridge)
- [Issues](https://github.com/goodaymmm/claude-gemini-multimodal-bridge/issues)

</td>
<td>

### 🔧 関連ツール
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Google AI Studio](https://aistudio.google.com/)
- [MCP](https://modelcontextprotocol.io/)

</td>
<td>

### 📜 利用規約
- [Google AI Studio](https://ai.google.dev/gemini-api/terms)
- [Claude](https://www.anthropic.com/terms)
- [Gemini API](https://ai.google.dev/gemini-api/docs/safety-guidance)

</td>
</tr>
</table>

---

## 📜 バージョン履歴

### v1.1.0 (2026-01-10)
- 🪟 **Windows完全対応**: CLI/MCP両方でWindowsをネイティブサポート
- 📝 **OCR機能強化**: 画像ベースPDFの自動OCR処理
- 🚀 **Gemini最新モデル**: gemini-2.5-flash, gemini-3-flash対応
- ⚡ **MCP統合改善**: 非同期レイヤー初期化の最適化
- 📈 **パフォーマンス向上**: タイムアウト短縮、遅延読み込み、キャッシング強化
- 🛡️ **エラー回復**: 指数バックオフによる95%の自己修復率

### v1.0.4
- 🎉 初期リリース
- 🏗️ 3層アーキテクチャ実装
- 🎨 基本的なマルチモーダル処理

---

<div align="center">

## 📄 ライセンス

MIT - [LICENSE](LICENSE) を参照

---

**Made with ❤️ by [goodaymmm](https://github.com/goodaymmm)**

*⭐ このプロジェクトが役に立ったら、スターをお願いします！*

</div>
