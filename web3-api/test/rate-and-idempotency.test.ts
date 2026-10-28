import {describe, expect, it} from 'vitest'

import {AppError} from '../src/errors.ts'
import {
  assertValidKey,
  hashRequest,
  MemoryIdempotencyStore,
} from '../src/idempotency.ts'
import {SlidingWindowLimiter} from '../src/rate-limit.ts'

describe('SlidingWindowLimiter', () => {
  it('allows up to max per window per key, then 429 with Retry-After', () => {
    const l = new SlidingWindowLimiter(3, 60_000)
    for (let i = 0; i < 3; i++) l.consume('a', 1000 + i)
    try {
      l.consume('a', 2000)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).statusCode).toBe(429)
      expect(Number((e as AppError).headers['retry-after'])).toBeGreaterThan(0)
    }
    l.consume('b', 2000) // other keys are independent
  })

  it('slides: old hits expire', () => {
    const l = new SlidingWindowLimiter(1, 1000)
    l.consume('a', 0)
    expect(() => l.consume('a', 500)).toThrow()
    l.consume('a', 1001)
  })
})

describe('idempotency', () => {
  const args = (key: string, request: unknown) => ({
    did: 'did:plc:a',
    operation: 'op',
    key,
    request,
  })

  it('requires a well-formed key', () => {
    for (const bad of [
      undefined,
      '',
      'short',
      'has space 12345',
      'x'.repeat(65),
    ]) {
      expect(() => assertValidKey(bad)).toThrow(AppError)
    }
    expect(assertValidKey('abcd-1234_EFGH')).toBe('abcd-1234_EFGH')
  })

  it('hashes independently of key order', () => {
    expect(hashRequest({a: 1, b: {c: 2, d: 3}})).toBe(
      hashRequest({b: {d: 3, c: 2}, a: 1}),
    )
    expect(hashRequest({a: 1})).not.toBe(hashRequest({a: 2}))
  })

  it('runs once and replays the stored response', async () => {
    const store = new MemoryIdempotencyStore()
    let runs = 0
    const fn = () => {
      runs++
      return Promise.resolve({status: 201, body: {id: runs}})
    }
    const first = await store.run(args('key-aaaaaaaa', {x: 1}), fn)
    const second = await store.run(args('key-aaaaaaaa', {x: 1}), fn)
    expect(runs).toBe(1)
    expect(first.replayed).toBe(false)
    expect(second).toMatchObject({replayed: true, status: 201, body: {id: 1}})
  })

  it('rejects the same key with a different request', async () => {
    const store = new MemoryIdempotencyStore()
    await store.run(args('key-aaaaaaaa', {x: 1}), () =>
      Promise.resolve({status: 201, body: {}}),
    )
    await expect(
      store.run(args('key-aaaaaaaa', {x: 2}), () =>
        Promise.resolve({status: 201, body: {}}),
      ),
    ).rejects.toMatchObject({code: 'idempotency_key_reuse', statusCode: 422})
  })

  it('does not store failures, so the client may retry with the same key', async () => {
    const store = new MemoryIdempotencyStore()
    await expect(
      store.run(args('key-aaaaaaaa', {x: 1}), () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom')
    const ok = await store.run(args('key-aaaaaaaa', {x: 1}), () =>
      Promise.resolve({status: 201, body: {ok: true}}),
    )
    expect(ok.replayed).toBe(false)
  })

  it('answers 409 while the first request is still running', async () => {
    const store = new MemoryIdempotencyStore()
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const first = store.run(args('key-aaaaaaaa', {x: 1}), async () => {
      await gate
      return {status: 201, body: {}}
    })
    await expect(
      store.run(args('key-aaaaaaaa', {x: 1}), () =>
        Promise.resolve({status: 201, body: {}}),
      ),
    ).rejects.toMatchObject({code: 'request_in_progress', statusCode: 409})
    release()
    await first
  })

  it('scopes keys per caller', async () => {
    const store = new MemoryIdempotencyStore()
    let runs = 0
    const fn = () => Promise.resolve({status: 201, body: {n: ++runs}})
    await store.run({...args('key-aaaaaaaa', {}), did: 'did:plc:a'}, fn)
    await store.run({...args('key-aaaaaaaa', {}), did: 'did:plc:b'}, fn)
    expect(runs).toBe(2)
  })
})
