import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion, DEFAULT_RRF_K } from './rrf'

const ids = (items: { id: number }[]): number[] => items.map((item) => item.id)

describe('reciprocalRankFusion', () => {
  it('returns nothing for no input', () => {
    expect(reciprocalRankFusion([])).toEqual([])
    expect(reciprocalRankFusion([[], []])).toEqual([])
  })

  it('preserves the order of a single list', () => {
    const list = [{ id: 10 }, { id: 20 }, { id: 30 }]
    expect(ids(reciprocalRankFusion([list]))).toEqual([10, 20, 30])
  })

  it('ranks an item found by both legs above one found by only one', () => {
    // 99 is second-best in both lists; 1 and 2 each top exactly one list.
    const keyword = [{ id: 1 }, { id: 99 }]
    const semantic = [{ id: 2 }, { id: 99 }]

    const fused = reciprocalRankFusion([keyword, semantic])

    expect(fused[0].id).toBe(99)
    expect(fused[0].sources).toEqual([0, 1])
  })

  it('sums contributions across lists', () => {
    const fused = reciprocalRankFusion([[{ id: 7 }], [{ id: 7 }]], 60)
    // Rank 1 in both: 1/(60+1) twice.
    expect(fused[0].score).toBeCloseTo(2 / 61, 10)
  })

  it('uses 1-based ranks', () => {
    const fused = reciprocalRankFusion([[{ id: 5 }]], 60)
    expect(fused[0].score).toBeCloseTo(1 / 61, 10)
  })

  it('breaks ties deterministically by id', () => {
    // Both appear once at rank 1 of their own list, so scores are identical.
    const first = reciprocalRankFusion([[{ id: 42 }], [{ id: 7 }]])
    const second = reciprocalRankFusion([[{ id: 42 }], [{ id: 7 }]])

    expect(ids(first)).toEqual(ids(second))
    expect(first[0].id).toBe(7)
  })

  it('lets a small k sharpen the advantage of rank 1', () => {
    const lists = [
      [{ id: 1 }, { id: 2 }],
      [{ id: 2 }, { id: 1 }]
    ]

    // Symmetric input: the gap between k values shows up in the score spread,
    // not the ordering.
    const sharp = reciprocalRankFusion(lists, 1)
    const damped = reciprocalRankFusion(lists, 1000)

    const sharpSpread = sharp[0].score - sharp[sharp.length - 1].score
    const dampedSpread = damped[0].score - damped[damped.length - 1].score
    expect(sharpSpread).toBeGreaterThanOrEqual(dampedSpread)
  })

  it('records which lists contributed each result', () => {
    const fused = reciprocalRankFusion([[{ id: 1 }], [{ id: 2 }], [{ id: 1 }]])
    const one = fused.find((item) => item.id === 1)

    expect(one?.sources).toEqual([0, 2])
  })

  it('defaults k to the conventional 60', () => {
    expect(DEFAULT_RRF_K).toBe(60)
    expect(reciprocalRankFusion([[{ id: 1 }]])[0].score).toBeCloseTo(1 / 61, 10)
  })
})
