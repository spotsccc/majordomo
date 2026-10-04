---
title: Cache Storage API Calls
impact: LOW-MEDIUM
impactDescription: reduces expensive I/O
tags: javascript, localStorage, storage, caching, performance
---

## Cache Storage API Calls

`localStorage`, `sessionStorage`, and `document.cookie` are synchronous and expensive. Cache reads in memory.

These helpers are browser-only: call them from event handlers and effects, not during a server render.

**Incorrect (reads storage on every call):**

```typescript
function getTheme() {
  return localStorage.getItem('theme') ?? 'light'
}
// Called 10 times = 10 storage reads
```

**Correct (Map cache):**

```typescript
const storageCache = new Map<string, string | null>()

function getLocalStorage(key: string) {
  if (!storageCache.has(key)) {
    let value: string | null = null
    try {
      value = localStorage.getItem(key)
    } catch {
      // Storage disabled or unavailable
    }
    storageCache.set(key, value)
  }
  return storageCache.get(key) ?? null
}

function setLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Quota exceeded or storage disabled
  }
  storageCache.set(key, value)  // keep cache in sync
}
```

Wrap every storage call in try/catch, as in [Version and Minimize localStorage Data](./client-localstorage-schema.md).

Use a Map (not a hook) so it works everywhere: utilities, event handlers, not just React components.

**Cookie caching:**

```typescript
let cookieCache: Map<string, string> | null = null

function getCookie(name: string) {
  if (!cookieCache) {
    cookieCache = new Map()
    for (const part of document.cookie.split('; ')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      // Values may contain '=' and percent-encoding
      cookieCache.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)))
    }
  }
  return cookieCache.get(name)
}
```

**Important (invalidate on external changes):**

If storage can change externally (another tab, server-set cookies), invalidate cache:

```typescript
window.addEventListener('storage', (e) => {
  // e.key is null when another tab called localStorage.clear()
  if (e.key === null) storageCache.clear()
  else storageCache.delete(e.key)
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    storageCache.clear()
    cookieCache = null
  }
})
```
