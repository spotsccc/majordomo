---
title: Use Lazy State Initialization
impact: MEDIUM
impactDescription: wasted computation on every render
tags: react, hooks, useState, performance, initialization
---

## Use Lazy State Initialization

Pass a function to `useState` for expensive initial values. Without the function form, the initializer runs on every render even though the value is only used once.

**Incorrect (runs on every render):**

```tsx
function FilteredList({ items }: { items: Item[] }) {
  // buildSearchIndex() runs on EVERY render, even after initialization
  const [searchIndex, setSearchIndex] = useState(buildSearchIndex(items))
  const [query, setQuery] = useState('')
  
  // When query changes, buildSearchIndex runs again unnecessarily
  return <SearchResults index={searchIndex} query={query} />
}

function UserProfile({ settingsJson }: { settingsJson: string }) {
  // JSON.parse runs on every render
  const [settings, setSettings] = useState(JSON.parse(settingsJson))
  
  return <SettingsForm settings={settings} onChange={setSettings} />
}
```

**Correct (runs only once):**

```tsx
function FilteredList({ items }: { items: Item[] }) {
  // buildSearchIndex() runs ONLY on initial render
  const [searchIndex, setSearchIndex] = useState(() => buildSearchIndex(items))
  const [query, setQuery] = useState('')
  
  return <SearchResults index={searchIndex} query={query} />
}

function UserProfile({ settingsJson }: { settingsJson: string }) {
  // JSON.parse runs only on initial render
  const [settings, setSettings] = useState(() => JSON.parse(settingsJson))
  
  return <SettingsForm settings={settings} onChange={setSettings} />
}
```

Use lazy initialization when building data structures (indexes, maps), parsing serialized input, or performing heavy transformations.

**SSR caveat:** in Next.js, client components also render on the server, where `localStorage`, `sessionStorage`, `window` and the DOM do not exist. Do not read them in a `useState` initializer of a server-rendered component: it throws on the server or causes a hydration mismatch. For client-only values, see [Prevent Hydration Mismatch Without Flickering](./rendering-hydration-no-flicker.md); wrap storage access in try/catch as in [Version and Minimize localStorage Data](./client-localstorage-schema.md).

For simple primitives (`useState(0)`), direct references (`useState(props.value)`), or cheap literals (`useState({})`), the function form is unnecessary.
