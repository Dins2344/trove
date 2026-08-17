import { importEsm } from './extract/types'

/**
 * Sentence embeddings, computed locally.
 *
 * all-MiniLM-L6-v2 is the pick because it is the best quality-per-megabyte
 * option for this job: 384 dimensions and ~25MB quantised, versus hundreds of
 * megabytes for marginally better retrieval. A first-run download the user
 * waits through has to stay small.
 */
export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

/** Quantised weights. ~4x smaller than fp32 for a negligible retrieval loss. */
export const DEFAULT_DTYPE = 'q8'

export interface DownloadProgress {
  file: string
  loaded: number
  total: number
  /** null when the server sent no content-length. */
  percent: number | null
}

export interface EmbedderOptions {
  modelId?: string
  /** Weights are cached here between runs so the download happens once. */
  cacheDir?: string
  dtype?: string
  onDownloadProgress?: (progress: DownloadProgress) => void
}

interface PipelineOutput {
  data: Float32Array
  dims: number[]
}

type FeatureExtractionPipeline = ((
  texts: string[],
  options: { pooling: string; normalize: boolean }
) => Promise<PipelineOutput>) & {
  dispose?: () => Promise<void>
}

interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    options: Record<string, unknown>
  ) => Promise<FeatureExtractionPipeline>
  env: Record<string, unknown>
}

export class Embedder {
  private constructor(
    private readonly extractor: FeatureExtractionPipeline,
    readonly modelId: string,
    readonly dimension: number
  ) {}

  static async create(options: EmbedderOptions = {}): Promise<Embedder> {
    const modelId = options.modelId ?? DEFAULT_MODEL_ID
    const transformers = (await importEsm('@huggingface/transformers')) as TransformersModule
    const { pipeline, env } = transformers

    if (options.cacheDir) {
      // Without this the weights land next to the executable, which is
      // read-only in a packaged install.
      env.cacheDir = options.cacheDir
    }
    // Trove ships no bundled weights; everything comes from the cache or the hub.
    env.allowLocalModels = false
    env.useFSCache = true

    const extractor = await pipeline('feature-extraction', modelId, {
      dtype: options.dtype ?? DEFAULT_DTYPE,
      progress_callback: options.onDownloadProgress
        ? (report: { status?: string; file?: string; loaded?: number; total?: number }) => {
            if (report.status !== 'progress') return
            const total = report.total ?? 0
            options.onDownloadProgress?.({
              file: report.file ?? 'model',
              loaded: report.loaded ?? 0,
              total,
              percent: total > 0 ? Math.round(((report.loaded ?? 0) / total) * 100) : null
            })
          }
        : undefined
    })

    // Probe the real output width rather than hard-coding 384: swapping the
    // model in options must not silently produce vectors of the wrong size.
    const probe = await extractor(['dimension probe'], { pooling: 'mean', normalize: true })
    const dimension = probe.dims[probe.dims.length - 1]

    return new Embedder(extractor, modelId, dimension)
  }

  /**
   * Embeds a batch of texts.
   *
   * Pooling and normalisation are done by the pipeline: mean-pooling has to
   * respect the attention mask or padding tokens drag every vector toward a
   * common centre, and getting that subtly wrong degrades retrieval in a way
   * that is very hard to notice by eye.
   */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    const output = await this.extractor([...texts], { pooling: 'mean', normalize: true })
    const dimension = output.dims[output.dims.length - 1]

    const vectors: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      // slice() copies, so each vector owns its buffer rather than holding the
      // whole batch alive.
      vectors.push(output.data.slice(i * dimension, (i + 1) * dimension))
    }

    return vectors
  }

  async dispose(): Promise<void> {
    await this.extractor.dispose?.()
  }
}
