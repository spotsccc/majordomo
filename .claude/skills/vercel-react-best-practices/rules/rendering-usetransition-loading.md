---
title: Use useTransition Over Manual Loading States
impact: LOW
impactDescription: reduces re-renders and improves code clarity
tags: rendering, transitions, useTransition, loading, state
---

## Use useTransition Over Manual Loading States

Use `useTransition` instead of manual `useState` for loading states. This provides built-in `isPending` state and automatically manages transitions.

**Incorrect (manual loading state):**

```tsx
function SearchResults() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [isLoading, setIsLoading] = useState(false)

  const handleSearch = async (value: string) => {
    setIsLoading(true)
    setQuery(value)
    const data = await fetchResults(value)
    setResults(data)
    setIsLoading(false)
  }

  return (
    <>
      <input onChange={(e) => handleSearch(e.target.value)} />
      {isLoading && <Spinner />}
      <ResultsList results={results} />
    </>
  )
}
```

**Correct (useTransition with built-in pending state):**

```tsx
import { useRef, useTransition, useState } from 'react'

function SearchResults() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [isPending, startTransition] = useTransition()
  const latestRequest = useRef(0)

  const handleSearch = (value: string) => {
    setQuery(value) // Update input immediately
    const requestId = ++latestRequest.current

    startTransition(async () => {
      const data = await fetchResults(value)
      // Responses can arrive out of order: ignore all but the latest
      if (requestId !== latestRequest.current) return
      // State updates after `await` need their own startTransition
      startTransition(() => {
        setResults(data)
      })
    })
  }

  return (
    <>
      <input value={query} onChange={(e) => handleSearch(e.target.value)} />
      {isPending && <Spinner />}
      <ResultsList results={results} />
    </>
  )
}
```

**Benefits:**

- **Automatic pending state**: No need to manually manage `setIsLoading(true/false)`
- **Better responsiveness**: Keeps the UI responsive during updates

**Caveats (from the React docs):**

- Set state after an `await` inside a nested `startTransition`, otherwise the update is not marked as a Transition.
- React does not cancel earlier transitions and does not keep their order. An older request can resolve last and overwrite newer results, so guard with a request id (as above), abort stale requests, or use `useActionState`, which handles ordering.
- If the action throws or rejects, the error goes to the nearest error boundary. Catch it inside the action if it should not replace the UI.

Reference: [useTransition](https://react.dev/reference/react/useTransition)
