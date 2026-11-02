/**
 * Plugin configuration. Every field carries a working default so the plugin
 * mounts from a profile with no configuration at all; the profile patch only
 * overrides what this machine needs.
 * @module cyberself/config
 */
import Schema from '@deepseek-ai/schemastery'

/** Ollama endpoint and model used to embed chunks. */
export interface EmbeddingSettings {
  /** Base URL of the Ollama HTTP server. */
  baseURL: string
  /** Embedding model id served by that server. */
  model: string
  /** Per-request timeout. */
  timeoutMs: number
  /** Texts sent per request; Ollama embeds a batch in one call. */
  batchSize: number
  /** Characters handed to the model per chunk; 0 keeps the whole chunk. */
  maxChars: number
  /** Table rows that differ only in numbers share one vector. */
  dedupeNumbers: boolean
}

/** Chunk boundaries applied after parsing. */
export interface ChunkingSettings {
  /** Target chunk length in characters. */
  targetChars: number
  /** Characters repeated from the previous chunk when one paragraph must be split. */
  overlapChars: number
  /** Chunks shorter than this are merged into the previous chunk when they share a heading. */
  minChars: number
}

/** How many excerpts retrieval returns and how they are balanced. */
export interface RetrievalSettings {
  /** Citations offered to the answer prompt. */
  topK: number
  /** Maximum citations from one document. */
  perDocument: number
  /** Minimum fused score; below this the excerpt is noise. */
  minScore: number
  /** Character budget for the evidence block handed to the model. */
  maxEvidenceChars: number
}

/** Answer generation. */
export interface AnswerSettings {
  /** Provider route; empty follows the Host's default model selection. */
  provider: string
  /** Model id; empty follows the Host's default model selection. */
  model: string
  temperature: number
  maxTokens: number
  /** Ask the model once more when the first answer cites nothing. */
  verify: boolean
}

/** Transcription of scanned pages and image files through a vision model. */
export interface OcrSettings {
  enabled: boolean
  /** Provider route for transcription; empty follows the Host's default model selection. */
  provider: string
  /** Model id for transcription; empty follows the Host's default model selection. */
  model: string
  /** Render resolution for scanned PDF pages, in dots per inch. */
  pdfDpi: number
  /** Upper bound of pages transcribed per document. */
  maxPages: number
  /** How many pages or pictures are transcribed at the same time. */
  concurrency: number
}

/** Resolved plugin configuration. */
export interface CyberSelfConfig {
  embedding: EmbeddingSettings
  chunking: ChunkingSettings
  retrieval: RetrievalSettings
  answer: AnswerSettings
  ocr: OcrSettings
}

/** Configuration schema; cordis resolves it before {@link apply} runs. */
export const Config = Schema.object({
  embedding: Schema.object({
    baseURL: Schema.string().default('http://127.0.0.1:11434').description('Ollama 服务地址'),
    model: Schema.string().default('bge-m3:latest').description('Ollama 嵌入模型'),
    timeoutMs: Schema.natural().default(120_000).description('单次嵌入请求的超时（毫秒）'),
    batchSize: Schema.natural().default(8).description('每次请求发送的文本条数'),
    maxChars: Schema.natural().default(0).description('送进模型的每块字符上限，0 表示不截断'),
    dedupeNumbers: Schema.boolean().default(true).description('表格里只有数字不同的分块共用一份向量'),
  }).description('嵌入模型设置'),
  chunking: Schema.object({
    targetChars: Schema.natural().default(1200).description('分块目标长度（字符）'),
    overlapChars: Schema.natural().default(120).description('长段落切分时的重叠长度'),
    minChars: Schema.natural().default(80).description('最小块长度'),
  }).description('分块设置'),
  retrieval: Schema.object({
    topK: Schema.natural().default(8).description('引用条数'),
    perDocument: Schema.natural().default(3).description('单文档最多引用的条数'),
    minScore: Schema.number().default(0.4).description('向量余弦相似度下限'),
    maxEvidenceChars: Schema.natural().default(12_000).description('证据总字数上限'),
  }).description('检索设置'),
  answer: Schema.object({
    provider: Schema.string().default('').description('回答使用的 provider，留空跟随默认模型'),
    model: Schema.string().default('').description('回答使用的模型，留空跟随默认模型'),
    temperature: Schema.number().default(0.2).description('采样温度'),
    maxTokens: Schema.natural().default(2048).description('回答长度上限'),
    verify: Schema.boolean().default(true).description('回答没有引用时追加一次核验'),
  }).description('回答设置'),
  ocr: Schema.object({
    enabled: Schema.boolean().default(true).description('对扫描页与图片做视觉转写'),
    provider: Schema.string().default('').description('转写使用的 provider，留空跟随默认模型'),
    model: Schema.string().default('').description('转写使用的模型，留空跟随默认模型'),
    pdfDpi: Schema.natural().default(160).description('扫描页渲染分辨率'),
    maxPages: Schema.natural().default(40).description('单文档最多转写的页数'),
    concurrency: Schema.natural().default(3).description('同时转写的页数或图片数'),
  }).description('视觉转写设置'),
})
