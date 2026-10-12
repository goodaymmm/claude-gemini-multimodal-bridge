<div align="center">

# 🌉 Claude-Gemini Multimodal Bridge

### *AIの力を、ひとつに。*

**Claude Code、Antigravity CLI、Google AI Studioをシームレスに統合するMCPブリッジ**

[🇺🇸 English](README.md) • [📦 NPM](https://www.npmjs.com/package/claude-gemini-multimodal-bridge) • [🐛 Issues](https://github.com/goodaymmm/claude-gemini-multimodal-bridge/issues)

---

[![npm version](https://img.shields.io/badge/npm-v1.3.0-CB3837?style=flat-square&logo=npm)](https://www.npmjs.com/package/claude-gemini-multimodal-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-00D4AA?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkw0IDdWMTdMN10gMjJWMTJMMTcgN1YxN0wxMiAyMlYxMkw3IDdWMTdMMTIgMjJMNy4gMTdWN0wxMiAyWiIgZmlsbD0id2hpdGUiLz48L3N2Zz4=)](https://modelcontextprotocol.io/)
[![Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=flat-square&logo=google-gemini&logoColor=white)](https://ai.google.dev/)
[![Claude](https://img.shields.io/badge/Claude-191919?style=flat-square&logo=anthropic&logoColor=white)](https://www.anthropic.com/)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-EA4AAA?style=flat-square&logo=GitHub-Sponsors&logoColor=white)](https://github.com/sponsors/goodaymmm)

[![Windows](https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white)](#-windows環境)
[![macOS](https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white)](#-クイックスタート)
[![Linux](https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black)](#-クイックスタート)

</div>

---

## 🤔 なぜ CGMB？

<table>
<tr>
<td width="33%" align="center">

### 🔄 マルチモデルオーケストレーション

Claude の**推論力**、Antigravity CLI の**検索力**、AI Studio の**生成力**を最適に統合。2026年のAIトレンド「専門AIの協調」を先取り

</td>
<td width="33%" align="center">

### ⚡ インストール1回、セットアップ2手順

`npm install -g` で MCP 統合まで完了。その後 `agy` の導入と AI Studio API キーの設定が必要です

</td>
<td width="33%" align="center">

### 🎯 MCP標準対応

Anthropic Model Context Protocol準拠。653件のテストを Linux / Windows / macOS の CI で push ごとに実行

</td>
</tr>
</table>

---

## ✨ v1.3.0 の変更

Google は 2026-09-18 以降、Gemini 2.5 系モデルをそれ以前から利用していた
アカウントにしか提供しておらず、新しい API キーでは AI Studio レイヤーが何も
返せませんでした。このリリースでは AI Studio の既定モデルを Gemini 2.5 から移し、
テキストを含む PDF をアップロードせずローカルで読む PDF モードを追加し、Node.js
の下限を 22.12.0 に引き上げます。あわせて、ルーティングを「自動ルーティング」の
説明どおりに、環境変数を「設定」の説明どおりに動くようにしました。いずれも実際の Gemini API・実際の `agy` では
実行していません（バージョン履歴を参照）。

| 変更 | 説明 |
|------|------|
| 🚀 **AI Studio の既定モデルを Gemini 2.5 から移行** | 汎用・ドキュメント・マルチモーダルは `gemini-3.5-flash-lite`（2.5 Flash と同価格）、画像は `gemini-3.1-flash-lite-image`、音声は `gemini-3.8-flash-tts` |
| 🔑 **新しい API キーを壊れていると判定しなくなりました** | キー確認に、新しいキーを拒否する `gemini-2.5-flash` を使っていました |
| 🎵 **音声ファイルの WAV ヘッダーは 1 つだけ** | 3.8 TTS は完全な WAV ファイルを返すため、ヘッダーを重ねて付けずそのまま書き出します |
| 📄 **テキストを含む PDF はローカルで読み取り** | テキストとして Gemini へ送り、アップロードするのはスキャン PDF だけです。新しい既定は `auto` で、`--pdf-mode upload` で従来の動作に戻せます |
| 🔐 **Antigravity のサインイン確認が実際のリクエストと一致** | `agy` に `GEMINI_API_KEY` を渡さず、API キーをサインインとみなさなくなりました。期限切れのサインインは未サインインと判定します |
| 🧭 **表記を Antigravity CLI に統一** | 残っていた「Gemini CLI」の案内を `agy` に修正。`cgmb detect-paths --fix` が一度も出なかった `agy` のインストール案内を表示します |
| 📦 **依存パッケージを現行メジャーへ更新** | `@google/genai` 2、commander 15、dotenv 18、pdf-parse 2、zod 4。Node.js ≥ 22.12.0。余分な CLI 引数はエラーになるため、プロンプトは引用符で囲みます |
| 📌 **lockfile をコミット** | `package-lock.json` をリポジトリに含めました。CI の `npm ci` への切り替えはまだです |
| 🧠 **推論とコードは Claude Code が回答** | 説明・比較・「なぜ」・設計・レビューと、コードを書く・直す・リファクタリングする依頼（英語・日本語）と、ソースファイルを、ルーティング表どおり Claude Code に送ります。これまでは自動では一度も Claude Code に届きませんでした |
| 🎨 **画像と音声の依頼を書いたとおりに認識** | "generate an image of …"、「イメージを生成」、"read this aloud"、「読み上げて」などが画像モデルと音声モデルに届きます。README_JP の画像生成の例では画像が作られていませんでした |
| 🌐 **PDF の URL を読み取り** | ダウンロード（50 MB・30 秒・リダイレクト 3 回まで）してアップロードします。これまで Gemini はプロンプトだけを見て回答していました |
| 📎 **Web ページの URL とファイルを両方読み取り** | ページは `agy`、ファイルは AI Studio が読みます。これまでファイルは捨てられていました |
| 🧹 **`layer_priority` と `--strategy` を案内から削除** | どちらも読まれていませんでした。受け付けはしますが、効果はありません |
| 🚫 **`--layer` は読めないファイルを拒否** | MCP ツールの `targetLayer` がすでにそうしていたのと同じです |
| 🔁 **MCP の検索も CLI と同じくフォールバック** | `agy` → AI Studio → Claude Code。回答にその旨を書き、すべてのレイヤーが失敗したときはエラーに各レイヤーの名前を示します |
| 🗑️ **到達不能なコードと未使用パッケージを削除** | どこからも到達できない 1,584 行と未使用の依存 4 つ（インストールされるパッケージは 19 減）。公開ファイルは 112 から 68 になり、`.claude/worktrees` のものは含みません |
| 🧩 **ワークフローを実行前に検査** | 存在しないステップを指す `dependsOn`、自己依存、循環、重複したステップ ID は、どのステップも実行する前に拒否します。`synthesize_response` はすべての入力を受け取ります |
| ⚙️ **README に書いた設定が効くように** | `CACHE_TTL` は秒単位、`ENABLE_CACHING=false` で検索キャッシュを無効化、`MAX_RETRIES` / `RETRY_DELAY` を読み取り、`--debug` は全コマンドで有効、`cgmb info` は `AI_STUDIO_API_KEY` を確認します |
| 🔇 **プロンプトをログに残さず、ツールのスキーマを修正** | 出力に「AI Studio」が含まれるたびにエラー行とスタックトレースが出ることはなくなりました。debug 未満のログには引数のキー・長さ・URL のホストだけを記録し、プロンプトは記録しません。`cgmb` ツールは案内どおりの `{prompt, args}` を受け付けます |

### v1.2.2 の変更

整理のみのリリースです。利用者から到達できる挙動は何も変わりません
（削除したコードはいずれも到達不能でした）。

| 変更 | 説明 |
|------|------|
| 🧹 **到達不能な 4 経路を削除** | サーバに実装のない MCP ツールを呼んでいました。現在は到達不能ですが、`--script` も同じ状態からでした |
| 🗑️ **未使用モジュール 740 行を削除** | `PromptOptimizer` と `quotaMonitor`。参照ゼロのまま同梱されていました |
| 🔒 **レイヤーとサーバの突き合わせを自動化** | サーバを起動して実装ツールを問い合わせ、レイヤーがそれ以外を名指しできる場合に失敗するテストを追加 |

### v1.2.1 の修正

| 修正 | 説明 |
|------|------|
| 🎯 **応答が依頼した呼び出し元へ届く** | AI Studio への並行リクエストが互いの応答を受け取っていました |
| 🚪 **`cgmb` が処理後に終了する** | 共有 MCP サーバを起動したまま放置せず、確実に終了させます |
| 🔑 **`.env` は自分のプロジェクトから読む** | インストール先や `~/.cgmb` は既定では読まず、`CGMB_ENV_PATH` で明示指定 |
| 🔍 **検索キャッシュが尋ねた質問に答える** | 年違い・モデル違いを同一エントリとして扱わなくなりました |
| 🧩 **ワークフローの各ステップが入力を受け取る** | parallel が出力を publish し、hybrid が `dependsOn` の順序を守ります |

---

## 🏗️ アーキテクチャ

```mermaid
flowchart TD
    A[Claude Code] --> B[CGMB]

    B --> C[Antigravity CLI]
    B --> D[Claude Code]
    B --> E[AI Studio]
```

| レイヤー | 得意分野 | タイムアウト |
|:--------:|:---------|:-----------:|
| 🔍 Antigravity CLI (`agy`) | Web検索、リアルタイム情報 | 90秒 |
| 🧠 Claude Code | 複雑な推論、コード分析 | 300秒 |
| 🎨 AI Studio | 画像生成、音声合成、OCR | 300秒 |

---

## 🚀 クイックスタート

### 📋 前提条件

- **Node.js** ≥ 22.12.0
- **Claude Code CLI** インストール済み
- **Antigravity CLI** (`agy`) 1.1.7 以上 — 別途インストールが必要（下記参照）

### 📦 インストール

```bash
npm install -g claude-gemini-multimodal-bridge
```

> 💡 postinstallスクリプトが自動で:
> - Antigravity CLI の有無を確認し、未導入ならインストール手順を表示
> - Claude Code MCP統合をセットアップ
> - API キーの置き場所を案内（`.env` は書き込みません）
> - システム要件を検証

### 🔑 環境設定

作業ディレクトリに `.env` ファイルを作成:

```bash
AI_STUDIO_API_KEY=your_api_key_here
```

🔗 APIキー取得: https://aistudio.google.com/app/apikey

### 🎯 Antigravity CLI のセットアップ

Google は 2026-06-18 に Gemini CLI の個人向け提供を終了しました。検索レイヤーは
後継の Antigravity CLI (`agy`) で動作します。npm では配布されていないため、
別途インストールしてください:

```bash
# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex

# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

インストール後、一度だけ起動してサインインします。ブラウザが開き、OAuth トークンは
OS のキーリングに保存されます。API キーも `agy auth` サブコマンドも存在しません:

```bash
agy
```

`agy models` で確認できます。CGMB は **agy 1.1.7 以上**が必要です
（それ以前のビルドは stdout が端末でない場合に何も出力しません）。

`cgmb detect-paths` は CGMB が見つけた `agy` を表示し、`cgmb info` とともに
`ANTIGRAVITY_CLI_PATH` が設定されているかを表示します。Gemini CLI 時代の
`GEMINI_CLI_PATH` が残っていても、`agy` を指していなければ無視されます。
代わりに `ANTIGRAVITY_CLI_PATH` を設定してください。

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
   - **🔍 Antigravity CLI**: Web検索、最新情報
   - **🎨 AI Studio**: 画像、音声、ファイル処理
   - **🧠 Claude Code**: 複雑な推論、コード分析

推論とは、説明・比較・分析・設計・レビューや「なぜ」を尋ねることを指し、コードとは
コードを書く・直す・リファクタリングする・レビューすることや、ソースファイルを
添付することを指します（ファイルの内容は 200 KB まで Claude Code に渡します）。
Web や現在についての言葉（最新、今日、ニュース、検索など）は Antigravity CLI が、
画像や音声の生成の依頼は AI Studio が優先します。どれにも当たらない短い質問は
Antigravity CLI に送ります。Web ページの URL は Antigravity CLI が読み、PDF の URL は
ダウンロードして AI Studio が読みます。ファイルも添付した場合はそれぞれを担当の
レイヤーが読み、両方の回答を返します。Claude Code がインストールされていないか
サインインしていない場合、Claude Code 向けのリクエストは Antigravity CLI に送ります。

---

## 🤖 使用モデル一覧

| 用途 | モデルID | レイヤー |
|:----:|:---------|:-------:|
| 🔍 Web検索 | `gemini-3.6-flash-low` | Antigravity CLI |
| 🎨 画像生成 | `gemini-3.1-flash-lite-image` | AI Studio |
| 🎵 音声生成 | `gemini-3.8-flash-tts` | AI Studio |
| 📄 ドキュメント処理 | `gemini-3.5-flash-lite` | AI Studio |
| 📝 OCR/テキスト抽出 | `gemini-3.5-flash-lite` | AI Studio |
| 🔮 汎用マルチモーダル | `gemini-3.5-flash-lite` | AI Studio |

Antigravity の行は既定値です。どの Antigravity モデル ID が有効かは手元の
`agy models` が決めます。一覧はアカウントとプランによって異なります（agy 1.2.16
で報告された一覧には `gemini-3.6` / `3.7` / `3.8` の Flash 各段階
`-low` / `-medium` / `-high` があります）。別のモデルは `ANTIGRAVITY_MODEL` または
`--model` で指定します。AI Studio 側の ID は `src/core/types.ts` の `AI_MODELS` に
あります。

---

## 📈 パフォーマンス

ベンチマーク値ではなく、実装が実際に行っていることです:

| 仕組み | 効く場面 | 調整 |
|--------|----------|------|
| 検索結果キャッシュ | 同じ Web 検索プロンプトの繰り返し | `ENABLE_CACHING` / `CACHE_TTL` / `MAX_CACHE_ENTRIES` |
| 認証キャッシュ | `agy` と Claude Code の認証確認を毎回ではなく数時間単位で | — |
| レイヤーの遅延初期化 | 起動時ではなく最初の利用時にレイヤーを起動 | — |
| 指数バックオフ付きリトライ | API や CLI の一時的な失敗 | `MAX_RETRIES` / `RETRY_DELAY` |

実際の速度はどのレイヤーが応答するかと上流 API に依存するため、固定の数値は
掲げていません。

---

## 📄 PDF処理 & OCR

### ✨ OCR機能

- ✅ テキストベースとスキャンPDF両対応
- ✅ OCR必要性を自動検出（まずローカルでテキストを抽出）
- ✅ スキャンPDFは Gemini File APIでネイティブOCR処理
- ✅ 多言語サポート

### 📋 処理ワークフロー

```
PDF入力 → ローカルでテキスト抽出 ─┬─ テキストあり           → テキストを Gemini へ送信 → 結果出力
                                  └─ スキャン/テキストなし → アップロード → OCR       → 結果出力
```

空白を除いて 100 文字以上のテキストがあるページをテキストページとみなし、5 ページ中 4 ページ
以上がテキストページの PDF はテキストで送ります。アップロードより安く待ち時間も
ありませんが、Gemini に届くのは文字だけで、図・グラフ・レイアウトは届きません。
ページそのものを見せたい場合はアップロードを指定してください:

| モード | 動作 | 指定方法 |
|--------|------|----------|
| `auto`（既定） | テキストがあればローカル抽出、なければアップロード | — |
| `local` | 常にローカル抽出。テキストのない PDF はエラー | `--pdf-mode local` |
| `upload` | 常にアップロード（1.2.2 までの動作） | `--pdf-mode upload` |

`--pdf-mode` は `analyze`・`multimodal`・`process`・`aistudio` で使えます。MCP
からは `options.pdf_mode` で指定します。既定は `CGMB_PDF_MODE`、ページあたりの
しきい値は `CGMB_PDF_TEXT_MIN_CHARS` で変更できます。PDF の URL は常にアップロード
されます。

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

ファイルは CGMB を実行した作業ディレクトリ配下に書き出され、生成された
ファイルのパスは応答に含まれます。

CGMB が Claude Code に公開する MCP ツールは `cgmb`、
`cgmb_get_layer_requirements`、`cgmb_document_analysis`、
`cgmb_multimodal_process`、`cgmb_workflow_orchestration` の5つです。

---

## 🔧 設定

### 環境変数

```bash
# 必須
AI_STUDIO_API_KEY=your_api_key_here

# 検索レイヤー (Antigravity CLI)
ANTIGRAVITY_MODEL=gemini-3.6-flash-low   # `agy models` に存在するもののみ
ANTIGRAVITY_TIMEOUT=90000                # 1回あたりのタイムアウト (ms)
ANTIGRAVITY_CLI_PATH=                    # 未設定なら自動検出

# Claude レイヤー
CLAUDE_CODE_PATH=/usr/local/bin/claude   # 既定の場所以外にある場合

# PDF: auto | local | upload（「PDF処理 & OCR」を参照）
CGMB_PDF_MODE=auto
CGMB_PDF_TEXT_MIN_CHARS=100
CGMB_ALLOW_PRIVATE_URLS=false            # true でプライベート/ループバックのアドレスの PDF URL も取得

# 検索キャッシュ
ENABLE_CACHING=true                      # false（または 0 / no / off）で無効
CACHE_TTL=3600                           # 秒、既定 1800。100000 以上は従来のミリ秒として読み、警告を出す
MAX_CACHE_ENTRIES=1000

# リトライ -- 空なら各レイヤーの既定値。不正な値は警告を出して無視
MAX_RETRIES=                             # 最初の試行のあとのリトライ回数、0-10（0 = リトライなし）
RETRY_DELAY=                             # 最初のリトライまでの ms、0-60000。以降は間隔を延ばす

# MCP サーバ
REQUEST_TIMEOUT=300000                   # ms、cgmb / cgmb_multimodal_process / cgmb_document_analysis 1 回あたりの上限

# ログ（stderr）
LOG_LEVEL=info                           # error | warn | info | debug。どのコマンドでも --debug で debug
CGMB_DEBUG=false                         # true で debug レベル（--debug と同じ）
LOG_FILE=                                # ログをこのファイルにも書き出す

# AI_STUDIO_API_KEY の非推奨フォールバック（前者を推奨）
GEMINI_API_KEY=your_api_key_here
```

### 🔐 Google へ送信してよいファイルの範囲

AI Studio レイヤーはファイルの内容を Google へアップロードするため、CGMB を
起動したディレクトリからしか読み取りません。それ以外の場所のファイルを扱う
場合は、対象ディレクトリを明示してください:

```bash
# 区切りは Windows が ";"、それ以外は ":"
CGMB_ALLOWED_ROOTS=C:\Users\me\Documents;D:\shared
```

### 📍 `.env` をどこから読むか

CGMB は実行したディレクトリの `.env` を読みます。1.2.0 までは CGMB 自身の
インストールディレクトリ、グローバル npm ディレクトリ、`~/.cgmb` も読んでいたため、
そこに置いた 1 つのファイルがマシン上のすべてのプロジェクトに適用されていました。
`AI_STUDIO_API_KEY` だけでなく、上記の境界を決める `CGMB_ALLOWED_ROOTS` まで
一緒に効いてしまいます。1.2.1 以降、これらの場所は明示指定が必要です:

```bash
# ファイル、またはそれを含むディレクトリ。作業ディレクトリより先に参照されます
CGMB_ENV_PATH=/home/me/.cgmb/.env
```

**1.2.0 以前からのアップグレード時**: 鍵を上記のいずれかに置いていた場合は、
この変数で指定してください。指定しないと鍵が見つからないと報告されます。

全一覧は `.env.example` にあります。パースされるだけで誰も読まない項目も
明記してあるので、設定が効くかどうかは先にそちらを確認してください。
`GEMINI_MODEL`、`GEMINI_TIMEOUT`、`GEMINI_MAX_OUTPUT_TOKENS`、
`GEMINI_TEMPERATURE`、`GEMINI_MAX_FILES`、`GEMINI_MAX_TOTAL_FILE_SIZE`、
`AISTUDIO_MCP_ENABLED` もその一部で、設定しても何も変わりません。AI Studio の
モデル ID は `AI_MODELS` で固定です。

### MCP統合

インストーラーが `cgmb setup-mcp` を実行し、CGMB を Claude Code に登録します:
- ⚡ `claude mcp add claude-gemini-multimodal-bridge <node> <cgmb>/dist/cli.js serve`。
  絶対パスで登録するため、Claude Code を起動したプロジェクトの PATH に左右され
  ません
- ✅ `claude mcp list` で確認できます。CGMB がなければ `cgmb setup-mcp` を実行して
  ください（`--dry-run` で実行するコマンドを表示します）
- 🔒 `claude mcp` コマンドのない Claude Code では、代わりに `mcp_servers.json` に
  既存サーバーを上書きせずマージして登録します

---

## 🪟 Windows環境

CGMB は v1.1.0 以降 Windows 環境を**完全サポート**しています:

| 機能 | 状態 |
|------|:----:|
| CLI | ✅ すべてのコマンドが動作 |
| MCP統合 | ✅ MCPツール呼び出しが正常動作 |
| パス解決 | ✅ `C:\path\to\file` 形式を自動処理 |
| Antigravity CLI | ✅ Windows版との完全な互換性 |

```powershell
# パスは絶対パスを推奨
cgmb analyze "C:\Users\name\Documents\report.pdf"

# 環境変数の設定（PowerShell）
$env:AI_STUDIO_API_KEY = "your_api_key_here"

# 環境変数の設定（コマンドプロンプト）
set AI_STUDIO_API_KEY=your_api_key_here
```

---

## 🐧 Linux / WSL環境

CGMBはLinuxおよびWSL環境で**完全に動作**:

| 機能 | 状態 |
|------|:----:|
| CLI | ✅ すべてのコマンドが動作 |
| MCP統合 | ✅ MCPツール呼び出しが正常動作 |
| パス解決 | ✅ `/mnt/` WSLパス、Unixパス対応 |
| Antigravity CLI | ✅ Linux版との完全な互換性 |

```bash
# Unixパス形式で使用
cgmb analyze /home/user/documents/report.pdf

# WSL環境での例
cgmb analyze /mnt/c/Users/name/Documents/report.pdf

# 環境変数の設定
export AI_STUDIO_API_KEY="your_api_key_here"
export ANTIGRAVITY_MODEL="gemini-3.6-flash-low"
```

### WSLでのテスト実行

テストはプラットフォームを判別し、両環境で同数のケースを実行します。Windows専用の
ケース（`.cmd` シムの扱い）にはPOSIX版が対になっており、POSIX専用のケース
（シグナルによる終了、`/mnt/c/Users` の探索）はWindowsではスキップされます。

```bash
cd /mnt/<drive>/path/to/claude-gemini-multimodal-bridge
node --version        # engines.node (>= 22) を満たすこと
npm run build         # ホスト側でビルド済みならそれを流用してもよい
node --test "tests/**/*.test.mjs"
```

---

## 🔍 トラブルシューティング

### デバッグモード

```bash
# --debug はグローバルオプションで、どのコマンドでも使えます
cgmb serve --debug
cgmb analyze /full/path/to/report.pdf --debug

# 環境変数でも指定できます（Claude Code が起動するサーバなど）
export LOG_LEVEL=debug   # CGMB_DEBUG=true でも同じ
```

ログは stderr に、`LOG_FILE` を設定した場合はそのファイルにも出力します。debug
未満のレベルでは、ツール呼び出しを引数のキー・プロンプトの長さ・ファイル数・URL の
ホストとして記録し、プロンプトそのものは記録しません。debug レベルでは引数を
そのまま記録し、URL はホストだけに切り詰めます。debug ログはプロンプトと同じように
扱ってください。

### OCRとPDF処理の問題

**OCR結果が不正確な場合:**
- 高解像度スキャンPDF（300+ DPI）を使用
- 明瞭で高コントラストなテキストを確保
- 傾きや回転した文書を避ける

**大きな文書でタイムアウトする場合:**
- テキストのある PDF はローカルで読み取られ、アップロードされません。
  `--pdf-mode local` で確実にそうできます
- 処理前に大きなPDFを分割（制限: 50MB、1,000ページ）
- AI Studio レイヤーの 300 秒は固定で、延長する環境変数はありません。
  分割が唯一の対処です

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
- [Antigravity CLI](https://antigravity.google/docs/cli)
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

### v1.3.0 (2026-10-11)

修正のみの 1.2.3 として準備していましたが、マイナーリリースとして公開します。
修正に加えて PDF モードを追加し、既定の動作を 1 つ変え（テキストを含む PDF は
アップロードしなくなります）、Node.js の下限を 22.12.0 に引き上げ、ランタイム依存
5 つをメジャー更新したためです。1.2.3 は公開していません。

- 🔑 **新しい AI Studio API キーで動作するようになりました**: Google は 2026-09-18 に
  Gemini 2.5 系モデルを、それ以前から利用していたアカウントに限定しました。非推奨では
  ありませんが、新しい API キーは拒否されます。`gemini-2.5-flash` は CGMB の汎用・
  ドキュメント処理・マルチモーダル分析の既定モデルであり、キー確認に使うモデルでも
  あったため、有効な新しいキーがリクエスト前の段階で壊れていると報告されていました。
  既定を新しいキーで使えるモデルへ移します:
  - `gemini-2.5-flash` → `gemini-3.5-flash-lite`（汎用・ドキュメント処理・
    マルチモーダル分析）。コンテキスト 1M トークン、料金 1M トークンあたり
    $0.30 / $2.50 とも同じで、請求額は変わりません
  - `gemini-2.5-flash-image` → `gemini-3.1-flash-lite-image`。Google が後継として
    名指しするモデルで、1 枚あたり約 $0.034、出力は 1K 解像度までです
  - `gemini-3.1-flash-tts-preview` → `gemini-3.8-flash-tts`。旧 ID はレガシーの
    プレビュー扱いになりました
  - `gemini-3-pro-preview` → `gemini-3.1-pro-preview`。旧 ID は 2026-03-09 に
    提供終了し、別名としてのみ残っています
- 🎵 **音声ファイルに WAV ヘッダーを二重に付けなくなりました**: 3.8 TTS は、従来の
  モデルが返していたヘッダーなしの PCM ではなく完全な WAV ファイルを返します。
  WAV ヘッダーを付けていた 2 箇所は、いずれもヘッダーを重ねるところでした。WAV は
  そのまま書き出し、上書き指定で選んだ旧 TTS モデルの PCM は従来どおりヘッダーを
  付けます。報告するサンプルレートとビット深度も、想定値ではなく音声の実際の値です
- 🔒 **モデル ID が再びずれないように**: `src/` 内のモデル ID はすべて `AI_MODELS`
  から取るようにし、`gemini-2.5-*` の直書きがあれば失敗するテストを追加しました
  （`gemini-2.0-*` は従来から検出しています）。設定スキーマの `gemini.model` の
  既定値はまだ `gemini-2.5-pro` でしたが、同じ定数に従うようにしました
- 🔐 **Antigravity のサインイン確認が実際のリクエストと同じ環境で行われます**: 確認は
  環境変数をすべて引き継いで `agy models` を実行していた一方、レイヤーは `agy -p` に
  `GEMINI_API_KEY` を含まない最小限の許可リストだけを渡していました。agy はこのキーを
  API キーモードの要求とみなすため、キーが設定されていると（CGMB 自身の `.env`
  テンプレートが設定します）、確認は「サインイン済み」と答えながら実際のリクエストは
  空のキーリングで実行される、ということが起きえました。両者は同じ許可リストを使う
  ようになり、CGMB の秘密情報は `agy` に渡りません
- ⏳ **期限切れのサインインを未サインインと判定します**: agy 1.3.1 以降、期限切れ・
  失効したサインインでは "Authentication expired. Please log back in." と表示され、
  これが障害と判定されることがありました。未サインインとして報告し、エラーで
  `agy` を再度実行するよう案内します
- 🔐 **Gemini API キーを Antigravity のサインインとみなさなくなりました**: サインインの
  案内とトークン更新は、`GEMINI_API_KEY` か `GOOGLE_API_KEY` が設定されていれば確認を
  実行せずに `agy` をサインイン済みと報告していました。インストーラーが新しい `.env`
  に書き込むプレースホルダーでも条件を満たすため、キーリングが空のまま新規インストール
  がサインイン済みと案内されていました。判定は確認の結果だけに基づき、メッセージも
  それに従います。未サインインなら `agy` の実行を、未インストールならインストール
  コマンドを案内し、時間内に応答しない `agy` はサインイン失敗ではなく不明と報告します。
  セットアップウィザードは、サインインに成功すると以前の「未サインイン」の結果を
  忘れます。公開メソッドの名前は変えておらず、AI Studio は従来どおり独自の経路で
  `AI_STUDIO_API_KEY` を読みます
- 📋 **Antigravity のモデル一覧を更新**: 参照用の一覧を、agy 1.2.16 で報告された
  `agy models` の出力に差し替えました — Gemini 3.6 / 3.7 / 3.8 Flash の各段階、
  3.1 Pro、Claude Opus / Sonnet 5.5 の各段階、`gpt-oss-120b-medium`。参考情報であり、
  この一覧を理由に拒否されるモデルはありません。有効かどうかは手元の `agy models` が
  決めます
- 🧭 **「Gemini CLI」表記を置き換え**: CLI の案内、起動時のヒント、依存関係チェック、
  ログが Antigravity CLI (`agy`) を名指しするようになりました。うち 1 件は欠陥で、
  `cgmb detect-paths --fix` が旧名と比較していたため `agy` のインストール案内が一度も
  表示されていませんでした。`detect-paths` は `ANTIGRAVITY_CLI_PATH` も表示します
- 📄 **テキストを含む PDF はローカルで読み取ります（既定の変更）**: 1.1.0 以降、PDF を
  扱う経路（`cgmb analyze`・`multimodal`・`process`・`aistudio -f` と 3 つの MCP
  ツール）はすべて Gemini File API でファイルをアップロードしており、コードに残って
  いたローカルのテキスト抽出には呼び出し元がありませんでした。ローカルの PDF はまず
  読み取り、80 % 以上のページに空白を除いて 100 文字以上のテキストがあれば、ファイル
  の代わりにテキストを Gemini へ送ります。アップロードより安く、待ち時間もありません。
  スキャン PDF や画像だけの PDF は従来どおりアップロードして Gemini に OCR させ、PDF
  の URL は常にアップロードします。これは意図した挙動の変更で、テキストを含む PDF
  では図・グラフ・レイアウトが Gemini に届かなくなります。モードは `analyze`・
  `multimodal`・`process`・`aistudio` の `--pdf-mode auto|local|upload`、MCP からは
  `options.pdf_mode` で指定し、既定は `CGMB_PDF_MODE`、ページあたりのしきい値は
  `CGMB_PDF_TEXT_MIN_CHARS` で変更できます。`upload` で 1.2.2 の動作に戻り、`local`
  はテキストのない PDF をエラーにし、不正な値は拒否します。判定は stderr のログ、
  `metadata.pdfs` に残り、CLI は PDF ごとに 1 行表示します。どこからも import されて
  いなかった `DocumentAnalysis`（1,029 行）は削除しました
- 🧹 **到達不能なコードをさらに 2 つ削除**: `WorkflowOrchestrator`（1,004 行。どこからも
  import されていなかった 2 つ目のワークフローエンジン）と
  `AIStudioLayer.processDocuments()`（呼び出し元なし。仮に呼ばれても、サーバがパス
  文字列を期待する箇所にオブジェクトを渡すため全文書が読み飛ばされ、成功を返して
  いました）、および未使用の `selectOptimalModel` / `getModelConfig`。削除は先に
  分離環境で試行して計測しました: 3 つのエントリポイントから到達できるモジュール、
  両サーバの `tools/list`、CLI の全 `--help` 画面、ルートの export はいずれも不変です。
  `dist/tools/workflowOrchestrator.js` は 1.2.2 の `PromptOptimizer` と同様に公開
  されなくなり、`processDocuments` は公開型 `AIStudioLayer` から消えます
- 📦 **ランタイム依存を現行メジャーへ更新**: `@google/genai` 1.52 → 2.28、commander
  11 → 15、dotenv 16 → 18、pdf-parse 1 → 2、zod 3 → 4。1 つずつ更新し、そのたびに
  テスト全体を実行しました。commander 15 と pdf-parse 2 が Node.js 22.12.0 を必要と
  するため、下限を 22.0.0 から **≥ 22.12.0** に引き上げます。利用者から見える変化:
  - dotenv 17 以降は読み込みのたびに 1 行表示し、18 は `DOTENV_*` 環境変数を読んで
    デバッグ出力を stdout に出します。stdout は MCP サーバが JSON-RPC を流す経路です。
    CGMB のローダーはすべてのオプションを dotenv 16 と同じ値に固定しているため、
    `DOTENV_*` に何が設定されていても `.env` の読み込みで stdout には何も出ません。
    テストでこれを確認しています
  - commander 13 で余分な引数がエラーになり、これはそのまま有効にしています。引用符
    なしの `cgmb generate-image a red fox` は "a" の画像を生成して課金していましたが、
    今後は拒否されます。複数語のプロンプトは引用符で囲んでください
  - pdf-parse 2 は API が異なります。旧来の 2 箇所の呼び出しを置き換えた 1 つの関数は、
    記載している上限（50MB / 1,000 ページ）を超える PDF を全体を読む前に拒否します

  変わらないもの: MCP ツールのスキーマは手書きの JSON で、両サーバの `tools/list` の
  出力は更新の前後でバイト単位まで同一です。zod スキーマ 58 個はいずれも zod 4 でも
  同じ入力を受け付け・拒否し、違うのは検証エラーの文言だけです。`@google/genai` 2 の
  変更は Interactions API のみで、偽のエンドポイントへ送るリクエストは 1.52 と 2.28
  で同一でした
- 🧰 **lint を ESLint 10 と typescript-eslint 8 へ、内容はそのまま**: ESLint 8 は
  サポートが終了しており、typescript-eslint 6 は TypeScript 5.9 に対応していません
  でした。ルールは同じ 14 個・同じ重大度で、プリセットは取り込んでいません。lint
  スクリプトは Linux と macOS で `src/cli.ts` と `src/index.ts` を検査していません
  でした。引用符のない glob をシェルが展開していたためです。glob を引用符で囲み、
  どのプラットフォームでも同じファイルを検査するようにしました。警告数が 127 → 131
  に増えたのはこのためだけです。rimraf は 6、`@types/node` は 22 系に更新し、
  TypeScript は 5.9 のままです
- 🧹 **古いバージョン表記・固定モデル・lockfile**: `package.json` の `mcp` ブロックは
  v1.2.0 のままでしたが 1.3.0 にしました。GitHub Pages のランディングページ
  (`docs/index.html`) は v1.1.0 のままで Gemini CLI を説明していました。
  `.claude/settings.json` はヘッドレスの Claude Code プロセスにレガシーの
  `claude-sonnet-5` を固定していましたが、`claude-sonnet-5-5` に変更しました。
  `package-lock.json` は gitignore されていたため、CI は実行のたびにバージョン範囲を
  解決し直し、3 つのプラットフォームが別々の依存ツリーをテストしうる状態でした。
  pdf-parse 2 が Windows と macOS で取り込むプラットフォーム別パッケージも含めて
  コミットしました。CI のインストール手順を `npm ci` に切り替える作業は未実施です
- 🧠 **推論とコードの依頼が Claude Code に届くようになりました**: README は複雑な推論と
  コード分析を Claude Code に割り当てていますが、自動ルーティングでそこに届く経路は
  ありませんでした。ファイルのない 1,000 文字未満のプロンプトはすべて `agy` に、
  コードファイルは AI Studio に送られていました。`cgmb` ツール、
  `cgmb_multimodal_process`、CLI のいずれも、1 つの規則 `LayerManager.decideRoute()`
  で振り分けるようにしました。説明・比較・なぜ・分析・設計・レビュー、コードを
  書く・直す・リファクタリングする・デバッグする依頼（日本語では 説明・比較・違い・
  なぜ・分析・設計・レビュー・コード・関数・実装・バグ・修正）は Claude Code に
  送ります。ソースファイルも Claude Code に送り、内容をプロンプトに埋め込みます
  （10 ファイル・200 KB まで。AI Studio が読めるディレクトリのものに限ります）。
  検索や最新情報の言葉は `agy` が、ファイルと生成は AI Studio が優先し、どれにも
  当たらない短い質問は `agy` のままです。Claude Code がインストールされていないか
  サインインしていない場合、その依頼は `agy` に（ソースファイルは AI Studio に）送り、
  stderr にその旨を 1 行出します
- 🎨 **画像と音声の依頼を書いたとおりに認識**: 一致したのは「generate image」だけ
  だったため、README 自身の例「generate an image of a futuristic city」は生成
  ワークフローになり、画像を 2 回生成して Claude の文章を返していました。README_JP の
  例「未来都市のイメージを生成してください」では画像が作られていませんでした。
  generate / create / draw / make / render と image / picture / illustration /
  photo / logo / icon の組み合わせは、順序を問わず画像モデルに届き、画像を生成・
  作成、イメージを生成、絵を描いて も同様です。generate / create / make と audio /
  speech / voice / narration、"read this aloud"、"text to speech"、音声を生成・
  作成、読み上げて は音声モデルに届きます。「create」だけで生成ワークフローが始まる
  ことはなくなり、生成したファイルのパスを返します
- 🌐 **PDF の URL を読み取るようになりました**: PDF の URL は AI Studio に送られて
  いましたが、サーバはそれを存在しないファイルとして読み飛ばしていました。そのため
  Gemini はプロンプトだけを見て回答し、成功と報告されていました。CLI はその後
  Claude Code にフォールバックしていましたが、Claude Code も文書を見ていません
  でした。サーバは PDF をダウンロードし（http か https、リダイレクト 3 回・30 秒・
  50 MB まで、中身が PDF であること）、この README が PDF の URL について書いている
  とおりアップロードし、一時ファイルを削除します。取得できない URL は AI Studio と
  その URL を示すエラーになり、読めないレイヤーへのフォールバックはしません。画像と
  音声の URL ははっきり拒否します。URL の直後に日本語が続いていても URL だけを読み
  取るようにしたため、README_JP の URL の例も AI Studio に届きます
- 📎 **Web ページの URL とファイルを両方読み取り**: Web ページの URL と一緒に送った
  ファイルは、何も言わずに捨てられていました。ページは `agy` に、ファイル（と PDF
  の URL）は AI Studio に送り、両方の回答を返します。どちらかが失敗した場合は、
  どちらかをエラーに示します。`cgmb analyze` に URL とローカルファイルを渡した場合も、
  URL の処理で止まらずローカルファイルを読みます
- 🛡️ **PDF の URL から内部アドレスに届かないように**: PDF の URL はプロンプト
  インジェクションから来ることもあり、ダウンロードは指定された先を何でも取得して
  いました。最初の URL とすべてのリダイレクト先について、ホストがプライベート・
  ループバック・リンクローカル（メタデータの 169.254.169.254 を含む）・CGNAT・
  マルチキャスト・予約済みのアドレスであるか、それに解決される場合と `localhost`
  は、`CGMB_ALLOW_PRIVATE_URLS=true` でない限り拒否します。https から http への
  リダイレクトは設定にかかわらず拒否します。拒否したアドレスが何であってもエラーは
  同じです。チェックと接続の間に DNS の応答が変わる場合（DNS リバインディング）は
  防げません。URL のログ行にはホストだけを記録し、パスやクエリは記録しません
- 🧹 **`layer_priority` と `--strategy` を案内から削除**: `cgmb_multimodal_process`
  は `options.layer_priority` を、`cgmb process` は `--strategy` を案内していました
  が、どちらも何にも読まれておらず、この README にも記載がありません。ツールの
  スキーマと `--help` から削除しました。既存の呼び出しが拒否されないよう、どちらも
  受け付けはします。`layer_priority` は無視し、`--strategy` は注意を表示します
- 🚫 **`--layer` は読めないファイルを拒否**: `cgmb analyze photo.png --layer claude`
  は、Claude が受け取っていない画像について回答して終了コード 0 で終わって
  いました。MCP ツールは同じ依頼を拒否していました。どちらも同じメッセージで拒否
  するようにしました。Claude が読むのはソースファイルだけで、`agy` はファイルを
  読みません
- 🔁 **MCP の検索も CLI と同じくフォールバック**: `agy` が失敗したとき（終了コード、
  タイムアウト、利用不可）、`cgmb` ツールの検索経路はエラーを返すだけでしたが、
  `cgmb analyze` は次のレイヤーを試していました。テキストの依頼はどちらも同じ順で
  フォールバックします。`agy` → AI Studio → Claude Code、Claude Code → `agy` →
  AI Studio。回答には代わりに答えたレイヤーを書き、すべてのレイヤーが失敗したときは
  エラーに各レイヤーの名前と理由を示します。ファイルを伴う依頼をファイルを読めない
  レイヤーにフォールバックしないこと、生成の依頼はフォールバックしないことは
  変わりません。`cgmb_get_layer_requirements` の説明に Claude レイヤーを加えました
- 🗑️ **到達不能なコードと未使用パッケージを削除**: `proxy/ClaudeProxy`、
  `proxy/RequestAnalyzer`、`intelligence/CapabilityDetector`、
  `services/IntelligentRouter`、`auth/types` の 5 モジュール（1,584 行）は、
  `claude` コマンドを横取りする旧設計の名残で、`src/index.ts`・`src/cli.ts`・
  AI Studio サーバのいずれからも到達できませんでした。非推奨の
  `resolveWindowsCommand` エイリアスとともに削除しました。`package.json` では:
  - `@modelcontextprotocol/sdk` ^1.0.0 → ^1.23.0。CGMB がすでに使っている zod 4 を
    依存範囲に含む最初のリリースです
  - `ansi-escapes`、`async-retry`、`node-cache`、`wav` はどこからも import されて
    おらず削除し、インストールされるパッケージが 19 減りました。存在しないファイルを
    指していた `benchmark` スクリプトも削除しました
  - `files` が `.claude` を指定していたため、`.claude/worktrees/` に残ったものは
    `.env` ファイルも含めて公開されるおそれがありました。`.claude/README.md` と
    `.claude/settings.json` だけを指定するようにしました。公開しないソースを指して
    いた宣言マップは出力しません。パッケージは 112 ファイルから 68 ファイルになり、
    `npm pack --dry-run` を実行するテストで確認しています
- 🧩 **ワークフローをどのステップよりも先に検査**: 逐次実行のワークフローは、
  `dependsOn` が存在しないステップを指していても、依存なしでそのステップを実行して
  いました。並列モードは一般的なエラーで失敗し、重複したステップ ID は何も言わずに
  読み飛ばされていました。どのモードでも、存在しないステップ・自己依存・循環
  （ループとして表示）・重複したステップ ID は、どのステップも実行する前に、ステップと
  ID を示して拒否します。MCP の呼び出し元には「Invalid workflow: …」が返ります
  - `synthesize_response` はプロンプトを `request`・`prompt`・`input`・`inputs`
    だけから組み立てていたため、`analysis: "@s1.output"` のような名前付きの入力は
    Claude に届かず、オブジェクトは「[object Object]」になっていました。すべての
    入力がプロンプトに届きます。名前付きの入力はラベル付きのセクションに、
    オブジェクトと配列はインデント付きの JSON（20,000 文字まで）になり、配列や
    オブジェクトの中の `@step` 参照も解決します
- ⚙️ **README に書いた環境変数が書いたとおりに効くように**:
  - `CACHE_TTL` はミリ秒として読まれていたため、この README の `CACHE_TTL=3600` は
    3.6 秒のキャッシュになっていました。秒単位になりました（既定 1800）。100000
    以上の値は従来どおりミリ秒として読み、警告を出します
  - `ENABLE_CACHING=false` は何もしていませんでした。検索キャッシュを無効にします
  - `MAX_RETRIES`（最初の試行のあとのリトライ回数、0–10）と `RETRY_DELAY`（最初の
    リトライまでの ms、0–60000）は記載されていましたが、何にも読まれていません
    でした。リトライ処理がこれらを使います。空または不正な値なら各レイヤーの既定値の
    ままです
  - `--debug` は `serve` にしかなく、フラグの解析前に作られたロガーには届いて
    いませんでした。全コマンド共通のグローバルオプションになり、実行時にレベルを
    切り替えます
  - `cgmb info` と認証情報の確認は `AI_STUDIO_API_KEY` を見ず、CGMB の何も読まない
    `CLAUDE_API_KEY` を設定済みと数え、廃止済みの `GEMINI_CLI_PATH` を表示して
    いました。`AI_STUDIO_API_KEY` と非推奨の別名 `GOOGLE_AI_STUDIO_API_KEY`・
    `GEMINI_API_KEY` を確認し、`ANTIGRAVITY_CLI_PATH` と `CLAUDE_CODE_PATH` を表示
    します。`detect-paths` は非推奨のキーの値を全桁表示しなくなりました
  - postinstall は、1.2.1 以降何にも読まれないグローバルのインストール先に `.env` を
    書き、キーとして `${GEMINI_API_KEY}` という文字列そのものを入れていました。
    何も書かず、キーの置き場所を案内するだけにしました。`CI=false` を CI とみなす
    こともなくなりました
  - Node 22 では常に失敗していたプロジェクトルートの `.env` 探索を削除しました。
    `.env` は実際にそうだったとおり、`CGMB_ENV_PATH`、次に作業ディレクトリから
    読みます。`setup.sh` と `verify-dependencies.sh` は Node.js 22.12 を要求し、
    MCP の登録を `claude mcp list` で確認します。`--pdf-mode` のヘルプを修正し、
    2 バイトしかなかった `docs/architecture.png` を削除しました
- 🔇 **プロンプトをログに残さず、`cgmb` ツールが案内どおりの形を受け付けるように**:
  - `AIStudioLayer` は `console.log` と `console.debug` を差し替え、行に「AI Studio」
    や「API」が含まれるたびにエラーとスタックトレースを出力していました。
    インスタンスごとに差し替えが重なっていました。この仕組みは削除しました
  - すべてのツール呼び出しの引数全体と AI Studio 子プロセスの stderr 全体をログに
    記録していたため、署名付き URL や貼り付けた秘密情報を含むプロンプトがそのまま
    `LOG_FILE` に残っていました。ログには引数のキー・プロンプトの長さ・ファイル数・
    URL のホストと、子プロセスの出力の 1 行目だけを記録します。引数全体を記録する
    のは debug レベルだけで、そこでも URL はホストだけに切り詰めます
  - `formattedData.geminiFormat` は `{prompt, args}` と案内されていたのに検証では
    `stdin` が必須だったため、案内どおりの呼び出しは `targetLayer` を失っていました。
    どちらの形も受け付け、どの `formattedData` でも `targetLayer` に従い、レイヤーを
    指定したのに検証に失敗した依頼は、別のレイヤーに回さず拒否します。何にも
    読まれていなかった `aistudioFormat` はスキーマから外し、警告付きで受け付けます
  - `cgmb_get_layer_requirements` は Imagen 3 と Veo 2 を説明していました。
    各レイヤーが実際にできることを現在のモデル ID とともに返し、動画は未実装と
    明記します。何にも読まれていなかった `AI_MODELS` のキー
    `IMAGE_GENERATION_PRO`（`gemini-3-pro-image`）、`GEMINI_FLASH_3`、
    `GEMINI_FLASH_3_PRO` を削除しました
  - AI Studio サブサーバのモジュールを（`node -e` や REPL から）import すると、
    そのプロセスの stdio で MCP サーバが起動していました。そのファイル自体を実行した
    ときだけ起動します
- 🔒 **入力がログや Claude に渡る範囲を縮小**:
  - ワークフローの入力で `@` から始まる文字列はすべてステップ参照とみなされ、
    `@scope/pkg` や `@here is the text` が「ステップがない」という印に置き換わり、
    文字列全体がログに残っていました。参照は `@` + ワークフローで宣言したステップ
    ID + 任意の `.path` の形だけとし、それ以外は書かれたとおりに渡します。解決
    できない参照はステップ ID とパスだけをログに記録します
  - Claude のステップは `files` 以外のすべての入力をプロンプトに入れていたため、
    文書ワークフローが持つ `documents` のパスが `synthesize_response`・
    `analyze_requirements`・`synthesize_analysis` から `claude --print` に渡って
    いました。`documents`・`filePaths`・`paths`・`imagePath` も `files` と同じく
    除外します。分析結果は従来どおり AI Studio のステップの出力から届きます
  - ログの URL の伏せ字は、`data:` や `mailto:` などの URL、スキームのない
    `host.tld/path?…`、任意のパスの `?…` / `#…` 以降にも及びます。ファイルパス、
    Windows のパス、時刻、比率はそのまま残します
  - リトライの警告と、失敗した処理のエラー行は、失敗メッセージ全体（子プロセスの
    出力最大 500 文字。後者はスタックトレース付き）を記録していました。どちらも
    1 行目だけを、URL はホストに切り詰め、最大 200 文字で記録し、スタックトレースは
    debug レベルだけに出します。呼び出し側が受け取るエラーは変わりません。
    AI Studio は各タスクの先頭 500 文字を info レベルで記録せず、キー・プロンプトの
    長さ・ファイル数・URL のホストだけを記録します
  - 捕捉したエラーは、一つ上の層で依然として全文がログに残っていました。403 を
    返した PDF URL では「Could not fetch <署名付きクエリを含む URL>」が stderr と
    `LOG_FILE` に書かれていました。すべてのレイヤー、MCP サーバ、サインインの確認、
    設定と `.env` の処理、エラーハンドラ、CLI で捕捉したエラーを記録する warn /
    error の行は、リトライの警告と同じく伏せ字を施した 1 行目だけを長さを抑えて
    記録します。`logger.error` に Error を渡した場合も同様で、スタックトレースは
    debug レベルだけに出します。ファイルパスの警告は、解決後のパスではなく渡された
    パスだけを記録します。ビルド結果のすべての `logger.warn` / `logger.error` の
    呼び出しを読み、生のエラーを渡す箇所が再び現れると失敗するテストを追加しました。
    呼び出し側が受け取るエラーは変わりません
  - AI Studio サブサーバの `get_generated_file` と `get_file_info` は任意のパスを
    読み取り・stat していました。他のツールと同じく許可ディレクトリに限ります。
    生成ファイルはサーバの作業ディレクトリ下の `output/` に置かれ、作業ディレクトリは
    常に許可されています
  - リクエストの `model` は検査なしで `agy --model` に渡っていました。モデル ID
    （英数字・`.`・`_`・`-`、最大 64 文字、`-` で始まらない）でない値は既定の
    モデルに置き換え、値そのものは繰り返さない警告を出します
  - 許可ディレクトリの確認より先にファイルの有無を調べていたため、許可ディレクトリ
    外のパスは存在するかどうかで応答が変わり、拒否メッセージには解決後のパスが
    出ていました。確認を先に、渡されたままのパスに対して行います。許可ディレクトリ
    外では、存在しないファイルも存在するファイルも同じ「File is not readable:
    <渡されたパス>」になり、外を指すシンボリックリンクはリンク先ではなく渡された
    名前で拒否します。「見つからない」と伝えるのは許可ディレクトリ内だけで、
    コードファイルのルーティングも許可ディレクトリ外のファイルを stat しません。
    許可ディレクトリ外のシンボリックリンクを経由してしか許可ディレクトリに届かない
    パスは拒否されるようになりました。実際のパスで指定してください
  - ログの伏せ字は、スキームもスラッシュもない `host.tld?query`、`Bearer`・
    `api_key=` / `api-key:`・`token=` / `token:` の後の値（ラベルは残し、
    `token: 3 retries` や「the Bearer scheme」はそのまま）、クエリのないパスの
    トークンらしい区間（数字を含む 20 文字以上）にも及びます。`cgmb info` と
    `cgmb detect-paths` はキーを 12 文字・8 文字ではなく先頭 4 文字と長さで表示し、
    形式が不正なキーは先頭 8 文字ではなく長さと先頭 2 文字で記録します
  - ステップ参照のパスは継承したプロパティもたどっていたため、
    `@s1.__proto__.constructor` でランタイムの関数がステップに渡っていました。
    ステップ出力自身のプロパティだけをたどり、それ以外は「ステップがない」という
    印になります
  - メインの `cgmb` ツールは、許可ディレクトリの確認より先にファイルの有無を
    調べており、メッセージには解決後のパスと作業ディレクトリが出ていました。
    同じ確認を先に行い、許可ディレクトリ外のパスには存在の有無にかかわらず
    サブサーバと同じ「File is not readable: <渡されたパス>」を返します。
    「見つからない」「ファイルではない」「読み取り権限がない」と伝えるのは許可
    ディレクトリ内だけで（後の二つは以前「Invalid file path」として届いていました）、
    どのメッセージにも解決後のパスや作業ディレクトリは出しません。プロンプト中に
    書かれたパスが許可ディレクトリ外なら添付しません
  - 許可ディレクトリ内から外を指すシンボリックリンクを経由すると、存在する
    ファイルは拒否され、存在しないファイルは「見つからない」と報告されていました。
    解決できないパスは、存在する部分で判断します。最も近い既存の親、または途中の
    リンクが外へ向かう場合は同じ拒否メッセージになり、リンク先のないリンクや、外から
    始まるシンボリックリンクのループも同様です。本当に許可ディレクトリ内のパスは、
    従来どおり「見つからない」やエラーコード（`ELOOP`）を伝えます
  - Claude へのコードファイルのルーティングは各ファイルを 2 回解決していました。
    読み取るのは、確認とサイズの計算をしたファイルそのものです
  - ログの伏せ字は、`Authorization: Basic` / `Proxy-Authorization: Basic`、
    引用符付きの `"key"`・`"secret"`・`"password"`・`"passwd"`・`"client_secret"`・
    `"access_token"`・`"refresh_token"`、`password=`・`passwd=`・`client_secret=`・
    `secret=` の後の値にも及びます。`"keyboard": "us"`、`secretary`、
    `password policy: 12 chars`、「basic auth is disabled」はそのまま残します
  - 許可ディレクトリ内の添付ファイルは実際のパス（realpath）で確認していましたが、
    レイヤーには渡されたパスのまま渡され、レイヤー側でもう一度解決されていました。
    メインの `cgmb` ツールは確認した実際のパスを渡すようになり、読み取るのは確認
    したファイルそのものです。名前には渡されたパスを使い、メッセージ、モデルに送る
    `File:` / `Document:` の行、`files_processed`、`metadata.pdfs` と PDF の
    アップロードでの名前には、実際のパスではなく渡されたパスを示します（そのために
    AI Studio サブサーバの `multimodal_process` はファイルごとに省略可能な
    `displayName` を、`analyze_documents` は省略可能な `display_names` を受け取ります）
  - シンボリックリンクのリンク先をリンク自身の名前から解決していたため、それ自体が
    シンボリックリンクであるディレクトリ（`dirA -> real/a`）の下では、リンク先の
    `..` が `real/a` ではなく `dirA` から上がっていました。そのため、こうしたリンクの
    先の存在しないファイルが外として拒否されたり、許可ディレクトリ内のシンボリック
    リンクのループが `ELOOP` ではなく外として扱われたりすることがありました。リンク
    先はリンクが実際にあるディレクトリから解決するようになり、外に出るものは従来
    どおり拒否します
  - JSON 文字列の中の引用符付きの値の伏せ字は、値の中のエスケープされた引用符
    （`\"a\\\"b\"`）で止まり、残りがログに出ていました。引用符付きの値は、
    通常の JSON でもエスケープされた JSON でも、二重引用符でも一重引用符でも、
    エスケープされていない最初の閉じ引用符までを伏せます
  - Claude へのコードファイルのルーティングは、インラインにした各ファイルの見出しと、
    バイナリファイルの「not a text file」エラーに実際のパスを出していました。どちらも
    渡されたパスを使うようになり、シンボリックリンクのリンク先は出しません
  - 実際のパスを渡すようにした結果、認証情報ファイル名のチェックがリンク先の名前
    しか見なくなり、許可ディレクトリ内の `.env -> config/dev.vars` が拒否されなく
    なっていました。渡されたパスと実際のパスの両方を調べ、どちらかが認証情報の
    形なら拒否します。URL の参照はパスと種別だけを持ち、呼び出し側が付けた余分な
    キーは捨てます
  - 呼び出し側が指定した表示名が stderr と「Cannot resolve」のメッセージにそのまま
    出ていたため、ログ行を偽装できました。1 行に収め、長さを抑え、URL はホスト名に
    切り詰めます。MIME 判定とコードファイルのルーティングに使う種別は、シンボリック
    リンクのリンク先ではなく呼び出し側が使った名前から決めます
  - 翻訳が使えないときの画像生成が「Translation unavailable」を `console.log` で
    出力しており、MCP の JSON-RPC の通り道である `cgmb serve` の stdout に混ざって
    いました。英語以外の画像プロンプトでクライアントの受信が壊れることがありました。
    stderr に出すようにし、どちらかの MCP サーバが読み込むモジュールが stdout に
    書き込むとテストが失敗するようにしました
  - AI Studio サブサーバは、ログ用に 200 文字に切り詰めた表示名からファイルの MIME
    種別を決めていたため、長い名前では拡張子が消え、PDF がテキストとして読まれて
    いました。種別は切り詰める前の名前から決め、切り詰めた形は表示だけに使います
  - 認証情報ファイル名のチェックは、ファイルを解決して渡された名前を保持する
    `cgmb` 以外のツールでは渡された名前しか見ておらず、`notes.txt -> .env` が
    `cgmb_multimodal_process`・`cgmb_document_analysis`・ワークフローの入力を
    通っていました。ファイルが存在すれば実際のパスの名前も調べ、これらのツール
    （と `cgmb`）はどのレイヤーにも渡す前に拒否します。答えは「Failed steps: 3」
    ではなく拒否そのもので、ツールのエラーには `(CREDENTIAL_FILE_REFUSED)` のように
    コードが付きます
  - `cgmb aistudio -f` は AI Studio レイヤーを直接呼び出し、認証情報ファイル名の
    チェックを通っていませんでした。レイヤーを起動する前にファイルを調べます。
    `analyze`・`multimodal`・`process` はもともとチェックを通っており、
    `generate-image` / `generate-audio` はファイルを受け取りません

**変更なし**: Antigravity の既定 `gemini-3.6-flash-low`、`MIN_AGY_VERSION`
（1.1.7）。export している識別子の名前は変えていません。`resolveWindowsCommand`
エイリアスと上記の `AI_MODELS` のキー 3 つは削除しました。これまで高品質な画像
生成のモデルとして載せていた `gemini-3-pro-image` は一覧から外しました。どの
コード経路からも選ばれていませんでした。テスト: 179 → 653（WAV ヘルパー 7 件、
スキーマ既定値 1 件、モデル表 2 件、Antigravity の確認と環境 8 件、API キーと
サインイン 3 件、依存の更新 10 件、PDF モード 24 件、ルーティング 106 件、PDF URL の
アドレス規則 81 件、公開ファイル一覧 5 件、ワークフローの検査と統合の入力 25 件、
キャッシュとリトライの変数 17 件、`cgmb info` 8 件、postinstall の `.env` の案内
3 件、CI の判定 3 件、Node.js の確認 1 件、console の差し替え 2 件、サブサーバの
import 6 件、`cgmb` ツールのスキーマ 14 件、各レイヤーのリトライ変数 13 件、ログの伏せ字とステップ参照 19 件、最終ハードニング 46 件、ルート検査 22 件、ルート検査の残り 20 件、両方の名前での認証情報チェック 3 件、stderr の表示名と渡された名前による種別判定 3 件、ログと名前の残り 22 件）。
Linux では 652 件が成功し、1 件はスキップです。
ルーティングの変更は、実際のサーバと CLI を動かす `tests/routing-matrix.test.mjs`
で固定しており、両方の README の使用例をすべて確認しています。

**実環境では未検証**: いずれも実際の Gemini API・実際の `agy` やキーリングに対しては
実行していません。セットアップウィザードは対話的にではなく、ウィザードが呼ぶ
メソッドを通して確認しました。モデル ID と 3.8 TTS の WAV 出力は Google の
ドキュメントとリリースノート、agy 1.3.1 の文言と 1.2.16 のモデル一覧はリリース
ノートとコード中で引用している GitHub issue に基づいています。PDF のテストは手作りの
PDF と偽の Gemini エンドポイントを使っています。実際の文書・スキャン PDF・日本語の
PDF では試しておらず、80 % / 100 文字のしきい値は測定ではなく推論で決めたもので、
新しい PDF のテストは Windows ではまだ実行していません。ルーティングの変更は、
`agy`・Claude Code・Gemini を記録用の代役に、PDF の URL をローカルのサーバに置き
換えて実行したもので、実際のサービスでは試していません。判定に使う語の一覧は
判断によるもので、実際のリクエストで測定したものではありません。

### v1.2.2 (2026-08-03)

整理のみのリリースです。利用者から到達できる挙動は何も変わりません。
削除したものはいずれも到達不能でした。

- 🧹 **到達不能な 4 経路を削除**: レイヤーは 9 つの MCP ツールを名指ししますが、
  サーバの実装は 8 つで、重なるのは 5 つでした。`analyze_audio_advanced` /
  `convert_file` / `convert_pdf` / `transcribe_audio` はサーバに存在したことがなく、
  呼べば `MCP error -32601` を返します。到達手段はありません —
  `task.type` に `'convert'` や `'audio_analysis_advanced'` を設定するコードはどこにもなく、
  `taskType` は MCP ツールのスキーマに無く、うち 2 つは呼び出し元自体がありませんでした。
  これは `generate_text` が `generate-audio --script` という入口を得て
  実害のある欠陥になる前とまったく同じ状態です。入口が付くのを待たせず削除しました
- 🔒 **レイヤーとサーバの突き合わせを自動化**: MCP サーバを起動して `tools/list` を問い合わせ、
  レイヤーがそこに無いツールを名指しできる場合に失敗するテストを追加しました。
  本リリース前は上記 4 件を検出します
- 🗑️ **未使用モジュール 740 行を削除**: `PromptOptimizer` と `quotaMonitor`。
  自身以外からの参照がなく、パッケージのエントリポイントからも export されていないまま
  `dist` に含まれて公開されていました
- 1.2.1 で「既知・未修正」としていた `analyze_audio_advanced` は 1 点目で解消しました

`AudioAnalysisResult` は `core/types.js` から引き続き export されます。
返していたメソッドは無くなりましたが、型自体は公開されている面の一部であり、
パッチリリースで落とすのは筋が悪いためです。

### v1.2.1 (2026-08-02)

修正のみのリリースです。すべて 1.2.0 で実測された欠陥への対応で、機能追加は
ありません。コードとテストで 18 ファイルに収まっています。

- 🎯 **AI Studio への並行リクエストが互いの応答を取らなくなりました**: 共有 MCP
  サーバに対して呼び出しごとに stdout リスナーを足し、最初に見えた応答で確定して
  いたため、2 つの呼び出しが同じ応答を受け取っていました。リクエスト ID も
  `Date.now()` で、同一ミリ秒の 2 件は衝突します。ID で応答を振り分け、ID は単調に
  なり、TTL で交代したプロセスが後任を巻き込んで失敗させることもなくなりました
- 🚪 **AI Studio 利用後に `cgmb` が終了します**: 共有 MCP サーバを終了する手段が
  なく、その stdio パイプが親プロセスを生かし続けていました。shutdown で確実に
  終了させ、さらに shell を経由せずに起動するため、終了処理が中間の shell ではなく
  サーバ本体に届きます
- 🔑 **`.env` はインストール先ではなくプロジェクトから読みます**: 既定でインストール
  ディレクトリ・グローバル npm ディレクトリ・`~/.cgmb` を読んでいました。他プロジェクト
  の `AI_STUDIO_API_KEY` に加え、**Google へ送ってよいファイルを決める
  `CGMB_ALLOWED_ROOTS`** まで引き込む点がより深刻です。これらは `CGMB_ENV_PATH` に
  よる明示指定のみとし、同変数はファイル・ディレクトリのどちらも受け付け、既定の
  探索先より優先されます
- 🔍 **検索キャッシュが尋ねた質問に答えます**: キーが 2024〜2029 年をすべて同一視し、
  「最新」「最近」「新しい」を畳み込み、モデルを含めていませんでした。2026 年の質問に
  2024 年の回答が返る、別モデルの回答が返る、といった誤りが起きていました
- 🧩 **ワークフローの各ステップが入力を受け取ります**: parallel が出力を publish せず、
  下流ステップが参照先の値なしで動いたうえ success を返していました。hybrid は
  `dependsOn` の順序を無視していました
- ⏱️ **タイムアウトが実際の処理量を反映します**: Claude の一般経路がレイヤー既定を
  下回る固定値を下限にし、見積りも実際に送るプロンプトを見ていませんでした
- 🔊 **提供終了モデル ID を除去**: 音声経路に `gemini-2.0-flash` が直書きされていました
- 🧪 **CI がテスト全体を実行します**: postinstall スクリプトが CI 環境でモジュール
  スコープから `process.exit(0)` していたため、これを `require` したプロセスごと
  終了していました。GitHub Actions 上でテスト 5 件が消えたまま緑になっていました

**削除**: `generate-audio --script`。「原稿を生成してから読み上げる」2 段階処理を
うたっていましたが、第 1 段が AI Studio サーバに存在しない `generate_text` ツールを
要求するため、本バージョン以前のすべてで `MCP error -32601` を返していました。
`--help` にのみ現れ、本 README にも `docs/` にも記載はありません。通常の
`generate-audio` は影響を受けません。2 段階処理は、検証できるリリースで作り直します。

**既知・未修正**: `audio_analysis_advanced` タスク種別が、サーバに実装のない
`analyze_audio_advanced` を呼びます。CLI からも MCP ツールからも到達できないため、
現状これを起動する手段はありません。

### v1.2.0 (2026-07-28)
- 🔄 **Antigravity CLI へ移行**: Google が 2026-06-18 に Gemini CLI の個人向け提供を
  終了したため、Web検索レイヤーは `agy` (Antigravity CLI 1.1.7 以降) を呼びます。
  認証は API キーではなく OS キーリング経由です。レイヤー名は `antigravity` が正準で、
  `gemini` も別名として引き続き使えます
- 🚀 **AI Studio モデル更新**: 高品質な画像生成に `gemini-3-pro-image`、音声生成に
  `gemini-3.1-flash-tts-preview` を採用。提供終了した `gemini-2.0-flash-exp` は
  直書きされていた6箇所すべてから除去しました
- 🖥️ **3OS 対応**: Linux / Windows / macOS を push ごとに CI で検証しています
- 🎯 **`targetLayer` が機能するように**: レイヤーを指定すればそこへ届きます。`claude`
  も指定可能になり、指定したのに別レイヤーが応答する挙動を修正しました
- 🔧 **`CLAUDE_CODE_PATH` が有効に**: 環境変数と `claude.code_path` が実行ファイルの
  探索に届くようになり、既定の場所以外のインストールも使えます
- 🧹 **デッドコード削除**: どこからも import されていなかったワークフロークラス
  3,619行を削除。公開 API の表面に変更はありません

### v1.1.0 (2026-01-10)
- 🪟 **Windows完全対応**: CLI/MCP両方でWindowsをネイティブサポート
- 📝 **OCR機能強化**: 画像ベースPDFの自動OCR処理
- 🚀 **Gemini最新モデル**: gemini-2.5-flash 対応
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

[![Sponsor](https://img.shields.io/badge/💖_Sponsor-Support_this_project-EA4AAA?style=for-the-badge)](https://github.com/sponsors/goodaymmm)

</div>
