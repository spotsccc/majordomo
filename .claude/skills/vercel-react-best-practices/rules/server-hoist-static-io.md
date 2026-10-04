---
title: Hoist Static I/O to Module Level
impact: HIGH
impactDescription: avoids repeated file/network I/O per request
tags: server, io, performance, next.js, route-handlers, og-image
---

## Hoist Static I/O to Module Level

**Impact: HIGH (avoids repeated file/network I/O per request)**

When loading static assets (fonts, logos, images, config files) in route handlers or server functions, hoist the I/O operation to module level. Module-level code runs once when the module is first imported, not on every request. This eliminates redundant file system reads or network fetches that would otherwise run on every invocation.

**Incorrect (reads font file on every request):**

```tsx
// app/api/og/route.tsx
import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function GET(request: Request) {
  // Runs on EVERY request - expensive!
  const fontData = await readFile(join(process.cwd(), 'assets/Inter.ttf'))
  const logoData = await readFile(join(process.cwd(), 'assets/logo.png'), 'base64')

  return new ImageResponse(
    <div style={{ fontFamily: 'Inter' }}>
      <img src={`data:image/png;base64,${logoData}`} />
      Hello World
    </div>,
    { fonts: [{ name: 'Inter', data: fontData }] }
  )
}
```

**Correct (loads once at module initialization):**

```tsx
// app/api/og/route.tsx
import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Module-level: runs ONCE when the module is first imported
const fontData = await readFile(join(process.cwd(), 'assets/Inter.ttf'))
const logoData = await readFile(join(process.cwd(), 'assets/logo.png'), 'base64')
const logoSrc = `data:image/png;base64,${logoData}`

export async function GET(request: Request) {
  return new ImageResponse(
    <div style={{ fontFamily: 'Inter' }}>
      <img src={logoSrc} />
      Hello World
    </div>,
    { fonts: [{ name: 'Inter', data: fontData }] }
  )
}
```

This mirrors the Next.js docs for `ImageResponse` and `opengraph-image`. Use literal paths so output file tracing includes the files (see [Prefer Statically Analyzable Paths](./bundle-analyzable-paths.md)). Prefer `fs` over the older Edge-runtime pattern `fetch(new URL('./file', import.meta.url))` in the Node.js runtime.

**Incorrect (reads config on every call):**

```typescript
import fs from 'node:fs/promises'

export async function processRequest(data: Data) {
  const config = JSON.parse(
    await fs.readFile('./config.json', 'utf-8')
  )
  const template = await fs.readFile('./template.html', 'utf-8')

  return render(template, data, config)
}
```

**Correct (hoists config and template to module level):**

```typescript
import fs from 'node:fs/promises'

const configPromise = fs
  .readFile('./config.json', 'utf-8')
  .then(JSON.parse)
const templatePromise = fs.readFile('./template.html', 'utf-8')

export async function processRequest(data: Data) {
  const [config, template] = await Promise.all([
    configPromise,
    templatePromise,
  ])

  return render(template, data, config)
}
```

**Caveat (module-level promises cache failures):** if a hoisted promise rejects, every later request gets the same rejection until the instance is recycled. For I/O that can fail transiently (network, remote config), drop the cached promise on failure:

```typescript
let configPromise: Promise<Config> | undefined

function loadConfig() {
  configPromise ??= fs
    .readFile('./config.json', 'utf-8')
    .then(JSON.parse)
    .catch((error) => {
      configPromise = undefined // retry on the next call
      throw error
    })
  return configPromise
}
```

When to use this pattern:

- Loading fonts for OG image generation
- Loading static logos, icons, or watermarks
- Reading configuration files that don't change at runtime
- Loading email templates or other static templates
- Any static asset that's the same across all requests

When not to use this pattern:

- Assets that vary per request or user
- Files that may change during runtime (use caching with TTL instead)
- Large files that would consume too much memory if kept loaded
- Sensitive data that shouldn't persist in memory

With Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute), module-level caching is especially effective because multiple concurrent requests share the same function instance. The static assets stay loaded in memory across requests without cold start penalties.

In traditional serverless, each cold start re-executes module-level code, but subsequent warm invocations reuse the loaded assets until the instance is recycled.
