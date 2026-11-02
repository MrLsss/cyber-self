/**
 * Embeddings through a local Ollama server (`/api/embed`). Nothing is bundled
 * with the plugin: the model runs in Ollama and is addressed over HTTP.
 * @module cyberself/embed/ollama
 */
import type { EmbeddingSettings } from '../config.ts'
import { CyberSelfError } from '../../shared/protocol.ts'

/** Whether the configured model is reachable right now. */
export interface OllamaProbe {
  ready: boolean
  message: string | null
}

/** Embedder bound to one model on one endpoint. */
export interface OllamaEmbedder {
  readonly model: string
  /** Check that the server answers and the model is installed. */
  probe(signal?: AbortSignal): Promise<OllamaProbe>
  /** Model names the endpoint has installed; empty when the endpoint does not answer. */
  models(signal?: AbortSignal): Promise<string[]>
  /** Embed texts in order, returning one vector per text. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}

interface TagsResponse {
  models?: { name?: string; model?: string }[]
}

interface EmbedResponse {
  embeddings?: number[][]
}

function endpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/u, '')}${path}`
}

function withTimeout(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

async function failure(response: Response): Promise<CyberSelfError> {
  const body = await response.text().catch(() => '')
  const detail = body.trim() === '' ? response.statusText : body.trim().slice(0, 400)
  return new CyberSelfError(502, `Ollama 嵌入请求失败（${response.status}）：${detail}`)
}

/** Create an embedder for the configured endpoint and model. */
export function createOllamaEmbedder(settings: EmbeddingSettings): OllamaEmbedder {
  const embedURL = endpoint(settings.baseURL, '/api/embed')
  const tagsURL = endpoint(settings.baseURL, '/api/tags')

  /** Ask the endpoint which models it has; a silent endpoint yields no names. */
  const fetchInstalled = async (signal?: AbortSignal): Promise<{ names: string[]; message: string | null }> => {
    const request = withTimeout(signal, Math.min(settings.timeoutMs, 5_000))
    let response: Response
    try {
      response = await fetch(tagsURL, { signal: request })
    } catch (error) {
      return { names: [], message: `连不上 Ollama（${settings.baseURL}）：${error instanceof Error ? error.message : String(error)}` }
    }
    if (!response.ok) return { names: [], message: `Ollama 返回 ${response.status}` }
    const body = await response.json() as TagsResponse
    const names = (body.models ?? [])
      .flatMap((model) => [model.name, model.model])
      .filter((name): name is string => typeof name === 'string')
    return { names: [...new Set(names)], message: null }
  }

  return {
    model: settings.model,

    async probe(signal) {
      const { names, message } = await fetchInstalled(signal)
      if (message !== null) return { ready: false, message }
      const wanted = settings.model
      const found = names.includes(wanted)
        || names.includes(`${wanted}:latest`)
        || names.some((name) => name.split(':')[0] === wanted.split(':')[0])
      return found
        ? { ready: true, message: null }
        : { ready: false, message: `Ollama 里没有模型 ${wanted}，请先 ollama pull ${wanted}` }
    },

    async models(signal) {
      const { names } = await fetchInstalled(signal)
      return names
    },

    async embed(texts, signal) {
      const vectors: Float32Array[] = []
      for (let start = 0; start < texts.length; start += settings.batchSize) {
        const batch = texts.slice(start, start + settings.batchSize)
        const request = withTimeout(signal, settings.timeoutMs)
        let response: Response
        try {
          response = await fetch(embedURL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: settings.model, input: batch, truncate: true }),
            signal: request,
          })
        } catch (error) {
          throw new CyberSelfError(502, `连不上 Ollama（${settings.baseURL}）：${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok) throw await failure(response)
        const body = await response.json() as EmbedResponse
        const embeddings = body.embeddings ?? []
        if (embeddings.length !== batch.length) {
          throw new CyberSelfError(502, `Ollama 返回 ${embeddings.length} 条向量，应为 ${batch.length} 条`)
        }
        for (const embedding of embeddings) {
          if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new CyberSelfError(502, `Ollama 返回了空向量，模型 ${settings.model} 不支持嵌入`)
          }
          vectors.push(Float32Array.from(embedding))
        }
      }
      return vectors
    },
  }
}
