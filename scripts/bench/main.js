/**
 * Indexing benchmark. Runs the real worker under real Electron.
 *
 *   npm run corpus && npm run bench
 *
 * Drives the shipped `out/worker/index.mjs` through a full index of a corpus
 * and reports the numbers that go in the README. Runs headlessly so it can be
 * repeated and, later, run in CI -- a benchmark nobody can reproduce is not
 * evidence of anything.
 */
const { app, utilityProcess } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..', '..')
const CORPUS = process.env.TROVE_BENCH_CORPUS ?? path.join(ROOT, '.corpus')
const WORK_DIR = process.env.TROVE_BENCH_WORKDIR ?? path.join(ROOT, '.bench')
const REPORT = path.join(WORK_DIR, 'report.txt')

const lines = []
function record(line) {
  lines.push(line)
  fs.mkdirSync(WORK_DIR, { recursive: true })
  fs.writeFileSync(REPORT, lines.join('\n') + '\n')
  process.stdout.write(line + '\n')
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`
}

app.whenReady().then(() => {
  if (!fs.existsSync(CORPUS)) {
    record(`corpus missing at ${CORPUS} -- run: npm run corpus`)
    app.exit(1)
    return
  }

  // Always start from an empty index so timings are cold-start comparable.
  fs.rmSync(WORK_DIR, { recursive: true, force: true })
  fs.mkdirSync(WORK_DIR, { recursive: true })

  const dbPath = path.join(WORK_DIR, 'bench.db')
  const modelCacheDir = process.env.TROVE_MODEL_CACHE ?? path.join(WORK_DIR, 'models')

  record(`Electron ${process.versions.electron} | Node ${process.versions.node}`)
  record(`corpus: ${CORPUS}`)

  const child = utilityProcess.fork(path.join(ROOT, 'out', 'worker', 'index.mjs'), [], {
    stdio: 'pipe'
  })

  child.stderr?.on('data', (data) => record(`[worker stderr] ${data.toString().trimEnd()}`))

  let settled = false
  let indexStartedAt = 0
  let peakRss = 0
  let lastPhase = null
  let phaseStartedAt = 0
  let indexHealthy = false
  const phaseTimes = {}
  const pendingSearches = new Map()
  let searchCounter = 0

  const runSearch = (query) =>
    new Promise((resolve) => {
      const requestId = `search-${searchCounter++}`
      pendingSearches.set(requestId, resolve)
      child.postMessage({ type: 'search', requestId, query, limit: 10 })
    })

  /**
   * Latency, plus the assertion that actually justifies the project: queries
   * that share no words with their target document must still find it.
   */
  async function runSearchBenchmark() {
    const semanticCases = [
      { query: 'how do I get paid', expect: 'payment-process.md' },
      { query: 'restart a stuck service', expect: 'service-restart.md' }
    ]

    const latencyQueries = [
      'invoicing',
      'deployment rollback',
      'how do I get paid',
      'when are tomatoes pruned',
      'new starter laptop',
      'expenses over fifty',
      'canary traffic percentage',
      'seed collection autumn',
      'ENOENT',
      'probation review'
    ]

    // Warm the caches so the first query does not skew p50.
    await runSearch('warmup query')

    const timings = []
    for (let pass = 0; pass < 3; pass++) {
      for (const query of latencyQueries) {
        const result = await runSearch(query)
        timings.push(result.elapsedMs)
      }
    }

    timings.sort((a, b) => a - b)
    const percentile = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))]

    record('')
    record('--- search latency ---')
    record(`queries          ${timings.length}`)
    record(`p50              ${percentile(0.5)}ms`)
    record(`p95              ${percentile(0.95)}ms`)
    record(`max              ${timings[timings.length - 1]}ms`)

    record('')
    record('--- semantic retrieval (no shared keywords) ---')
    let semanticPassed = true
    for (const testCase of semanticCases) {
      const result = await runSearch(testCase.query)
      const rank = result.hits.findIndex((hit) => hit.fileName === testCase.expect)
      const top = result.hits[0]

      const ok = rank >= 0 && rank < 3
      if (!ok) semanticPassed = false
      record(
        `"${testCase.query}" -> ${testCase.expect}: ${
          rank < 0 ? 'NOT FOUND' : `rank ${rank + 1}`
        } ${ok ? 'PASS' : 'FAIL'}`
      )
      if (top) {
        record(`    top hit: ${top.fileName} (keyword=${top.matchedKeyword} semantic=${top.matchedSemantic})`)
      }
    }

    const p95 = percentile(0.95)
    record('')
    record(`latency budget (<150ms p95): ${p95 < 150 ? 'PASS' : 'FAIL'}`)
    record('')

    const healthy = indexHealthy && semanticPassed && p95 < 150
    record(healthy ? 'STATUS: OK' : 'STATUS: PROBLEM')
    finish(healthy ? 0 : 1)
  }

  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 250)

  const finish = (code) => {
    if (settled) return
    settled = true
    clearInterval(sampler)
    app.exit(code)
  }

  child.on('message', (event) => {
    switch (event.type) {
      case 'ready':
        record('worker ready, loading model…')
        break

      case 'model-download':
        if (event.percent !== null && event.percent % 25 === 0) {
          record(`  downloading ${event.file}: ${event.percent}%`)
        }
        break

      case 'model-ready': {
        record(`model: ${event.modelId} (${event.dimension}d)`)
        indexStartedAt = Date.now()
        child.postMessage({ type: 'index', requestId: 'bench', folders: [CORPUS] })
        break
      }

      case 'progress': {
        if (event.phase !== lastPhase) {
          const now = Date.now()
          if (lastPhase !== null) {
            phaseTimes[lastPhase] = (phaseTimes[lastPhase] ?? 0) + (now - phaseStartedAt)
          }
          lastPhase = event.phase
          phaseStartedAt = now
          record(`  phase: ${event.phase}`)
        }
        break
      }

      case 'done': {
        const total = Date.now() - indexStartedAt
        if (lastPhase !== null) {
          phaseTimes[lastPhase] = (phaseTimes[lastPhase] ?? 0) + (Date.now() - phaseStartedAt)
        }
        const c = event.counters
        record('')
        record('=== RESULTS ===')
        record(`files seen       ${c.filesSeen}`)
        record(`files indexed    ${c.filesIndexed}`)
        record(`files skipped    ${c.filesSkipped}`)
        record(`files failed     ${c.filesFailed}`)
        record(`chunks written   ${c.chunksWritten}`)
        record(`chunks embedded  ${c.chunksEmbedded}`)
        record(`chunks pending   ${c.chunksPending}`)
        record('')
        record('')
        record('--- time by phase ---')
        for (const [phase, ms] of Object.entries(phaseTimes)) {
          record(`${phase.padEnd(16)} ${(ms / 1000).toFixed(1)}s (${((ms / total) * 100).toFixed(0)}%)`)
        }
        record('')
        record(`total time       ${(total / 1000).toFixed(1)}s`)
        record(`throughput       ${(c.chunksEmbedded / (total / 1000)).toFixed(0)} chunks/sec`)
        record(`files/sec        ${(c.filesIndexed / (total / 1000)).toFixed(0)}`)
        record(`peak RSS (main)  ${formatBytes(peakRss)}`)
        record(`db size          ${formatBytes(fs.statSync(dbPath).size)}`)

        indexHealthy = c.chunksPending === 0 && c.filesFailed === 0 && c.chunksEmbedded > 0
        runSearchBenchmark()
        break
      }

      case 'search-results': {
        const pending = pendingSearches.get(event.requestId)
        if (pending) {
          pendingSearches.delete(event.requestId)
          pending(event)
        }
        break
      }

      case 'error':
        record(`ERROR${event.fatal ? ' (fatal)' : ''}: ${event.message}`)
        if (event.fatal) finish(1)
        break
    }
  })

  child.on('exit', (code) => {
    if (!settled) {
      record(`worker exited early with ${code}`)
      finish(1)
    }
  })

  child.postMessage({ type: 'init', dbPath, modelCacheDir })

  setTimeout(() => {
    record('TIMEOUT')
    finish(1)
  }, 900000)
})
