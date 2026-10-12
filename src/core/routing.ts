/**
 * What a request is asking for, read from its prompt.
 *
 * These are the signals LayerManager.decideRoute() combines with the request's
 * files and URLs to pick a layer. They live apart from LayerManager only so
 * they can be tested without one; the routing decision itself is made in one
 * place, LayerManager.decideRoute(), for the MCP server and the CLI alike.
 *
 * The README promises three destinations:
 *
 *   Antigravity CLI   web search, latest information
 *   AI Studio         images, audio, file processing (OCR, documents)
 *   Claude Code       complex reasoning, code analysis
 *
 * Matching is on whole words (or, for Japanese, on the phrase), not on
 * substrings: "concurrent" is not "current", "findings" is not "find", and
 * "drawbacks" is not "draw".
 */

/** A route decision: which layer answers, and why. */
export type RouteKind =
  /** PDF / image / audio URLs (and any local files sent with them) -> AI Studio. */
  | 'file_url'
  /** Web page URLs -> Antigravity CLI. */
  | 'web_url'
  /** Web page URLs plus files: the URLs to Antigravity, the files to AI Studio. */
  | 'web_and_files'
  | 'image_generation'
  | 'audio_generation'
  /** Search or current-information wording -> Antigravity CLI. */
  | 'search'
  /** Reasoning or code wording without files -> Claude Code. */
  | 'reasoning'
  /** Source-code files only, small enough to inline -> Claude Code. */
  | 'code_files'
  /** Any other files -> AI Studio (one or two directly, more as a workflow). */
  | 'files'
  /** A long or multi-step request with no other signal -> the analysis workflow. */
  | 'workflow'
  /** A short question with no signal at all -> Antigravity CLI. */
  | 'plain';

/** True if `text` matches any of the patterns. */
const any = (text: string, patterns: readonly RegExp[]): boolean =>
  patterns.some(pattern => pattern.test(text));

// --- Code ---------------------------------------------------------------------

const CODE_VERB = /\b(?:write|writing|implement|implementing|refactor|refactoring|debug|debugging|fix|fixing|find|spot|optimi[sz]e|optimi[sz]ing|review|create|build|generate|make|rewrite|port|convert|translate|code|unit[- ]test|document)\b/i;
// Verbs that are about code whatever follows them.
const CODE_ONLY_VERB = /\b(?:debug|debugging|refactor|refactoring)\b/i;
const CODE_NOUN = /\b(?:functions?|class(?:es)?|methods?|code|codebase|scripts?|bugs?|tests?|unit tests?|algorithms?|programs?|snippets?|regex(?:es)?|regular expressions?|sql quer(?:y|ies)|endpoints?|components?|modules?|compile errors?|compiler errors?|stack traces?|exceptions?|segfaults?|recursion|hooks?)\b/i;
const LANGUAGE = /(?:\b(?:typescript|javascript|python|java|rust|golang|kotlin|swift|ruby|php|haskell|scala|elixir|clojure|perl|lua|dart|bash|powershell|sql|node\.js|nodejs|react|vue|svelte|angular|django|flask)\b|\bc\+\+|\bc#|\bf#)/i;
const CODE_FENCE = /```/;
const CODE_JA = /(?:コード|関数|実装|バグ|リファクタ|デバッグ|プログラム|スクリプト|クラス|メソッド|修正)/;
// "Pythonで…を書いて": a language name and a Japanese "write / make".
const CODE_JA_VERB = /(?:書いて|書く|作って|作成|実装)/;

/** A prompt about writing, fixing or reviewing code. */
export function hasCodeIntent(prompt: string): boolean {
  if (CODE_FENCE.test(prompt) || CODE_JA.test(prompt) || CODE_ONLY_VERB.test(prompt)) {
    return true;
  }
  if (LANGUAGE.test(prompt) && CODE_JA_VERB.test(prompt)) {
    return true;
  }
  return CODE_VERB.test(prompt) && (CODE_NOUN.test(prompt) || LANGUAGE.test(prompt));
}

/**
 * Code nouns strong enough to outweigh an image or audio noun: "write a
 * function that renders an image" is code, "generate an image of a python" is
 * not. Language names alone do not count, for that reason.
 */
function mentionsCodeArtifact(prompt: string): boolean {
  return CODE_FENCE.test(prompt) || /\b(?:functions?|class(?:es)?|methods?|code|scripts?|components?|programs?|modules?|endpoints?|regex|unit tests?|api)\b/i.test(prompt);
}

// --- Reasoning ----------------------------------------------------------------

const REASONING_EN = /\b(?:explain|explains|explanation|compare|comparing|comparison|why|analy[sz]e|analy[sz]ing|analysis|design|designing|difference|differences|differ|pros and cons|architecture|architectural|review|trade-?offs?|evaluate|evaluation|reason about|step by step|justify|critique|prove|derive|assess)\b/i;
const REASONING_JA = /(?:説明|比較|違い|なぜ|どうして|分析|設計|レビュー|評価|考察|理由)/;

/** A prompt asking for explanation, comparison, analysis or design. */
export function hasReasoningIntent(prompt: string): boolean {
  return REASONING_EN.test(prompt) || REASONING_JA.test(prompt);
}

// --- Search and current information ---------------------------------------------

/**
 * Years that make a question about the present: last year, this year, next.
 * Computed, so the router does not go stale the way a literal "2024" did.
 */
function currentYears(now: Date = new Date()): string[] {
  const year = now.getFullYear();
  return [String(year - 1), String(year), String(year + 1)];
}

const SEARCH_EN: readonly RegExp[] = [
  /\b(?:latest|today|today's|tonight|news|headlines|breaking|current|currently|recent|recently|nowadays|right now|up[- ]to[- ]date|this (?:week|month|year))\b/i,
  // "search" as an instruction, not as a topic: "binary search", "search tree"
  // and "full-text search" are code questions.
  /^\W*(?:cgmb\s+)?(?:please\s+)?(?:search|google|look\s?up)\b/i,
  /\b(?:search|searching)\s+(?:the\s+)?(?:web|internet|online|for|about)\b/i,
  /\b(?:look\s?up|google)\b/i,
];
const SEARCH_JA = /(?:最新|今日|本日|ニュース|検索|調べて|調べる|最近|現在|今年|今週|今月)/;

/** A prompt that needs the web or current information. */
export function hasSearchIntent(prompt: string, now: Date = new Date()): boolean {
  if (any(prompt, SEARCH_EN) || SEARCH_JA.test(prompt)) {
    return true;
  }
  return currentYears(now).some(year => new RegExp(`(?:^|\\D)${year}(?:\\D|$)`).test(prompt));
}

// --- Generation ---------------------------------------------------------------------

const GEN_VERB = '(?:generate|generating|create|creating|draw|drawing|make|making|render|rendering|design|paint|produce|illustrate)';
const IMAGE_NOUN = '(?:images?|pictures?|illustrations?|photos?|photographs?|logos?|icons?|drawings?|artworks?|wallpapers?|posters?|sketch(?:es)?|paintings?)';
// Image nouns that name something other than a picture to make.
const NOT_A_PICTURE = /\b(?:docker|container|disk|iso|vm|base|os|system|boot)\s+images?\b|\bpicture\s+books?\b|\bimages?\s+(?:files?|formats?|sizes?|tags?|urls?|uploads?|classifiers?|classification|recognition|processing|registry|layers?|metadata)\b/i;

const IMAGE_EN: readonly RegExp[] = [
  // verb ... noun: "generate an image of", "create a logo for", "make me a picture"
  new RegExp(`\\b${GEN_VERB}\\b[^.?!\\n]{0,40}?\\b${IMAGE_NOUN}\\b`, 'i'),
  // noun ... verb: "an image of a city, generated in watercolour"
  new RegExp(`\\b${IMAGE_NOUN}\\b[^.?!\\n]{0,40}?\\b(?:generated|created|drawn|rendered|painted)\\b`, 'i'),
  // a bare imperative "draw a cat" -- but not "draw a conclusion"
  /^\W*(?:cgmb\s+)?(?:please\s+)?draw\s+(?:me\s+)?(?:a|an|some|the)\s+(?!(?:conclusions?|comparisons?|distinctions?|lines?|parallels?|inferences?)\b)/i,
];
const IMAGE_JA = /(?:画像|イメージ|イラスト|絵|写真|ロゴ|アイコン|ポスター)(?:を|の)?(?:生成|作成|作って|作る|描いて|描く|描き)/;

/** A prompt asking for an image to be made. */
export function hasImageGenerationIntent(prompt: string): boolean {
  if (IMAGE_JA.test(prompt) || /画像生成/.test(prompt)) {
    return true;
  }
  if (!any(prompt, IMAGE_EN) || mentionsCodeArtifact(prompt)) {
    return false;
  }
  // "create a docker image" is not a picture -- unless the prompt also asks for
  // "an image of" something, which is.
  return !NOT_A_PICTURE.test(prompt) || /\b(?:image|picture|illustration|photo)\s+of\b/i.test(prompt);
}

const AUDIO_VERB = '(?:generate|generating|create|creating|make|making|produce|producing|synthesi[sz]e|record|render)';
const AUDIO_NOUN = '(?:audio|speech|voice|voices|voice-?over|narration|spoken (?:version|audio)|tts)';
// Nouns that name software rather than sound.
const NOT_SOUND = '(?!\\s*(?:assistants?|recognition|recogni[sz]ers?|apps?|bots?|interfaces?|chat|commands?|search|-to-text|to text|transcription|transcripts?|files? format|codecs?))';

const AUDIO_EN: readonly RegExp[] = [
  new RegExp(`\\b${AUDIO_VERB}\\b[^.?!\\n]{0,40}?\\b${AUDIO_NOUN}\\b${NOT_SOUND}`, 'i'),
  /\bread\b[^.?!\n]{0,30}?\b(?:aloud|out loud)\b/i,
  /\btext[- ]to[- ]speech\b/i,
  /\b(?:say|speak)\s+(?:this|it|the following)\b[^.?!\n]{0,20}?\b(?:aloud|out loud|in a voice)\b/i,
];
const AUDIO_JA = /(?:音声(?:を)?(?:生成|作成|作って|合成)|読み上げ|ナレーション(?:を)?(?:生成|作成|作って))/;

/** A prompt asking for speech or audio to be made. */
export function hasAudioGenerationIntent(prompt: string): boolean {
  if (AUDIO_JA.test(prompt) || /音声生成/.test(prompt)) {
    return true;
  }
  return any(prompt, AUDIO_EN) && !mentionsCodeArtifact(prompt);
}

// --- Multi-step ------------------------------------------------------------------------

const WORKFLOW_WORDS = /\b(?:workflow|orchestrate|convert|transform|analy[sz]e multiple)\b/i;

/** Wording that asks for the multi-step workflow rather than one answer. */
export function hasWorkflowIntent(prompt: string): boolean {
  return WORKFLOW_WORDS.test(prompt);
}

// --- URLs ------------------------------------------------------------------------------

/**
 * URLs in free text.
 *
 * Stops at whitespace and at any character a URL cannot contain unescaped, so
 * "https://example.com/document.pdfを分析してください" yields the URL and not
 * the Japanese sentence after it -- the README_JP example was classified as a
 * web page, and sent to the search layer, because of exactly that.
 */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g) ?? [];
  return found
    .map(url => url.replace(/[.,;:!?'")\]]+$/, ''))
    .filter(url => url.length > 'https://'.length);
}

/** What a URL points at, from its shape. */
export function urlKind(url: string): 'pdf' | 'image' | 'audio' | 'web' {
  const lower = url.toLowerCase();
  const urlPath = lower.split(/[?#]/)[0] ?? lower;

  // A "/pdf" path segment or a type=pdf query names a PDF without the
  // extension; the AI Studio server checks the bytes either way. "/pdf-tools"
  // is a web page.
  if (urlPath.endsWith('.pdf') || /\/pdf(?:\/|$)/.test(urlPath) || /[?&](?:type|format)=pdf\b/.test(lower)) {
    return 'pdf';
  }
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(urlPath)) {
    return 'image';
  }
  if (/\.(mp3|wav|m4a|ogg|flac|aac)$/.test(urlPath)) {
    return 'audio';
  }
  return 'web';
}
