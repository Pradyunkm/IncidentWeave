import { Redis } from '@upstash/redis'

// In-memory fallback store when UPSTASH_REDIS credentials are not provided
class InMemoryRedis {
  constructor() {
    this.store = new Map()
    this.counters = new Map()
  }

  async lpush(key, ...values) {
    if (!this.store.has(key)) this.store.set(key, [])
    const list = this.store.get(key)
    list.unshift(...values)
    return list.length
  }

  async lrange(key, start, stop) {
    const list = this.store.get(key) || []
    if (stop === -1) {
      return list.slice(start)
    }
    return list.slice(start, stop + 1)
  }

  async ltrim(key, start, stop) {
    const list = this.store.get(key) || []
    const trimmed = stop === -1 ? list.slice(start) : list.slice(start, stop + 1)
    this.store.set(key, trimmed)
    return 'OK'
  }

  async hset(key, obj) {
    if (!this.store.has(key)) this.store.set(key, {})
    const hash = this.store.get(key)
    Object.assign(hash, obj)
    return Object.keys(obj).length
  }

  async hgetall(key) {
    return this.store.get(key) || null
  }

  async hdel(key, ...fields) {
    const hash = this.store.get(key) || {}
    let count = 0
    for (const f of fields) {
      if (f in hash) {
        delete hash[f]
        count++
      }
    }
    return count
  }

  async incr(key) {
    const val = (this.counters.get(key) || 0) + 1
    this.counters.set(key, val)
    return val
  }

  async set(key, value, _options) {
    // _options (e.g. { ex: ttlSeconds }) are accepted but ignored in the
    // in-memory fallback — TTL is not enforced without a real Redis instance.
    this.store.set(key, value)
    return 'OK'
  }

  async get(key) {
    return this.store.get(key) || null
  }

  async del(key) {
    this.store.delete(key)
    this.counters.delete(key)
    return 1
  }

  async expire() {
    return 1
  }
}

const cleanUrl = process.env.UPSTASH_REDIS_REST_URL ? process.env.UPSTASH_REDIS_REST_URL.trim() : ''
const cleanToken = process.env.UPSTASH_REDIS_REST_TOKEN ? process.env.UPSTASH_REDIS_REST_TOKEN.trim() : ''

let clientInstance = new InMemoryRedis()
try {
  if (cleanUrl && cleanToken && cleanUrl.startsWith('https://')) {
    clientInstance = new Redis({
      url: cleanUrl,
      token: cleanToken,
    })
  }
} catch (err) {
  console.warn('[redis] Failed to initialize Upstash Redis, falling back to InMemory:', err)
  clientInstance = new InMemoryRedis()
}

export const redis = clientInstance