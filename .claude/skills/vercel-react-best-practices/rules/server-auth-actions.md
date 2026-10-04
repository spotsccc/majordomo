---
title: Authenticate Server Actions Like API Routes
impact: CRITICAL
impactDescription: prevents unauthorized access to server mutations
tags: server, server-actions, authentication, security, authorization
---

## Authenticate Server Actions Like API Routes

**Impact: CRITICAL (prevents unauthorized access to server mutations)**

Server Actions (functions with `"use server"`) are exposed as public endpoints, just like API routes. Always verify authentication and authorization **inside** each Server Action—do not rely solely on middleware, layout guards, or page-level checks, as Server Actions can be invoked directly.

Next.js documentation explicitly states: "Treat Server Actions with the same security considerations as public-facing API endpoints, and verify if the user is allowed to perform a mutation."

**Incorrect (no authentication check):**

```typescript
'use server'

export async function deleteUser(userId: string) {
  // Anyone can call this! No auth check
  await db.user.delete({ where: { id: userId } })
  return { success: true }
}
```

**Correct (authentication inside the action):**

```typescript
'use server'

import { verifySession } from '@/lib/auth'

export async function deleteUser(userId: string) {
  // Always check auth inside the action
  const session = await verifySession()
  
  if (!session) {
    return { error: 'Must be logged in' }
  }
  
  // Check authorization too
  if (session.user.role !== 'admin' && session.user.id !== userId) {
    return { error: 'Cannot delete other users' }
  }
  
  await db.user.delete({ where: { id: userId } })
  return { success: true }
}
```

**With input validation:**

```typescript
'use server'

import { verifySession } from '@/lib/auth'
import { z } from 'zod'

const updateProfileSchema = z.object({
  userId: z.uuid(),
  name: z.string().min(1).max(100),
  email: z.email()
})

export async function updateProfile(data: unknown) {
  // Validate input first
  const parsed = updateProfileSchema.safeParse(data)
  if (!parsed.success) {
    return { error: 'Invalid input' }
  }
  const validated = parsed.data
  
  // Then authenticate
  const session = await verifySession()
  if (!session) {
    return { error: 'Unauthorized' }
  }
  
  // Then authorize
  if (session.user.id !== validated.userId) {
    return { error: 'Can only update own profile' }
  }
  
  // Finally perform the mutation
  await db.user.update({
    where: { id: validated.userId },
    data: {
      name: validated.name,
      email: validated.email
    }
  })
  
  return { success: true }
}
```

Expected failures are returned as values so the client can show them. Follow the project's error convention (see `AGENTS.md`).

Reference: [https://nextjs.org/docs/app/guides/authentication](https://nextjs.org/docs/app/guides/authentication)
