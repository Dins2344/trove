/**
 * Generates a synthetic document corpus for benchmarking and manual testing.
 *
 *   node scripts/make-corpus.mjs [outDir] [fileCount]
 *
 * Deliberately synthetic: benchmarks should be reproducible and shareable, and
 * nobody's real documents should have to be involved to reproduce a number in
 * the README.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2] ?? join(process.cwd(), '.corpus')
const fileCount = Number(process.argv[3] ?? 1200)

const TOPICS = [
  {
    name: 'invoicing',
    heading: 'Invoicing',
    sentences: [
      'Submit your invoice to the finance team before the fifth of each month.',
      'Payment runs happen on the tenth and the twenty-fifth.',
      'Late submissions roll over into the following payment cycle.',
      'Contractors must attach a signed timesheet to every claim.',
      'Purchase orders above ten thousand require director approval.'
    ]
  },
  {
    name: 'onboarding',
    heading: 'Onboarding',
    sentences: [
      'New starters receive a laptop on their first morning.',
      'Accounts are provisioned by the platform team within one working day.',
      'Every new joiner is assigned a buddy for their first month.',
      'The security induction must be completed within two weeks.',
      'Probation reviews happen at the three month mark.'
    ]
  },
  {
    name: 'deployment',
    heading: 'Deployment',
    sentences: [
      'Releases are cut from the main branch every Thursday afternoon.',
      'A rollback is expected to take under four minutes.',
      'Database migrations run ahead of the application rollout.',
      'Canary traffic is held at five percent for thirty minutes.',
      'On-call engineers are paged automatically when error rates spike.'
    ]
  },
  {
    name: 'gardening',
    heading: 'Gardening',
    sentences: [
      'Prune the tomato plants back hard before the first frost.',
      'Mulch the beds deeply once the soil has warmed through.',
      'Rotate the brassica bed to a different corner each season.',
      'Water the greenhouse early in the morning during summer.',
      'Collect seed from the strongest plants at the end of autumn.'
    ]
  },
  {
    name: 'travel',
    heading: 'Travel',
    sentences: [
      'Book flights at least three weeks ahead of any conference.',
      'Hotel spend is capped at two hundred per night in major cities.',
      'Taxi receipts must be itemised to be reimbursed.',
      'Trips longer than five days need line manager sign-off.',
      'Travel insurance is arranged centrally by the operations team.'
    ]
  }
]

/** A handful of unmistakable targets for the semantic-search test. */
const NEEDLES = [
  {
    path: 'handbook/payment-process.md',
    body: `# Employee Handbook

## Remuneration

Salaries are transferred on the last working day of the month. Contractors are
settled separately through the accounts payable run. If a transfer has not
arrived within three working days, raise a ticket with the finance desk.
`
  },
  {
    path: 'runbooks/service-restart.md',
    body: `# Service Runbook

## Recovering a wedged process

Drain the node from the load balancer first. Send SIGTERM and wait thirty
seconds before escalating to SIGKILL. Confirm the health endpoint returns green
before returning the node to the pool.
`
  }
]

function buildDocument(index) {
  const topic = TOPICS[index % TOPICS.length]
  const secondary = TOPICS[(index + 2) % TOPICS.length]
  // Vary length so chunking is exercised rather than every file being one chunk.
  const paragraphs = 2 + (index % 6)

  const lines = [`# ${topic.heading} note ${index}`, '']

  for (let p = 0; p < paragraphs; p++) {
    const source = p % 3 === 2 ? secondary : topic
    if (p % 3 === 0) {
      lines.push(`## Section ${p + 1}`, '')
    }
    const sentences = []
    for (let s = 0; s < 3 + (p % 3); s++) {
      sentences.push(source.sentences[(index + p + s) % source.sentences.length])
    }
    lines.push(sentences.join(' '), '')
  }

  if (index % 17 === 0) {
    lines.push('```bash', `deploy --service ${topic.name} --revision ${index}`, '```', '')
  }

  return lines.join('\n')
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const needle of NEEDLES) {
  const target = join(outDir, needle.path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, needle.body, 'utf8')
}

// Spread across nested folders so the walker is exercised too.
for (let i = 0; i < fileCount; i++) {
  const folder = join(outDir, `team-${i % 12}`, `topic-${i % 5}`)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `note-${i}.md`), buildDocument(i), 'utf8')
}

// Noise the walker must ignore.
mkdirSync(join(outDir, 'node_modules', 'junk'), { recursive: true })
writeFileSync(join(outDir, 'node_modules', 'junk', 'index.js'), 'module.exports = 1', 'utf8')

console.log(`Wrote ${fileCount + NEEDLES.length} documents to ${outDir}`)
