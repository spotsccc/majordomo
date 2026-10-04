---
title: Prevent Hydration Mismatch Without Flickering
impact: MEDIUM
impactDescription: avoids visual flicker and hydration errors
tags: rendering, ssr, hydration, localStorage, flicker
---

## Prevent Hydration Mismatch Without Flickering

When rendering content that depends on client-side storage (localStorage, cookies), avoid both SSR breakage and post-hydration flickering by injecting a synchronous script that updates the DOM before React hydrates.

**Incorrect (breaks SSR):**

```tsx
function ThemeWrapper({ children }: { children: ReactNode }) {
  // localStorage is not available on server - throws error
  const theme = localStorage.getItem('theme') || 'light'
  
  return (
    <div className={theme}>
      {children}
    </div>
  )
}
```

Server-side rendering will fail because `localStorage` is undefined.

**Incorrect (visual flickering):**

```tsx
function ThemeWrapper({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState('light')
  
  useEffect(() => {
    // Runs after hydration - causes visible flash
    const stored = localStorage.getItem('theme')
    if (stored) {
      setTheme(stored)
    }
  }, [])
  
  return (
    <div className={theme}>
      {children}
    </div>
  )
}
```

Component first renders with default value (`light`), then updates after hydration, causing a visible flash of incorrect content.

**Correct (no flicker, no hydration warning):**

```tsx
// app/layout.tsx — a Server Component
const themeScript = `
  (function() {
    try {
      var theme = localStorage.getItem('theme') || 'light';
      document.documentElement.classList.add(theme);
    } catch (e) {}
  })();
`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The script changes <html> attributes before hydration
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

The inline script is part of the server HTML and runs synchronously before the page paints, so the DOM already has the correct value. `suppressHydrationWarning` on `<html>` silences only the expected attribute difference on that element (it does not apply to children).

Render the script from a Server Component such as the root layout. React does not execute `<script>` tags that it creates on the client, and React 19 warns when a component renders one there.

This pattern is especially useful for theme toggles, user preferences, and any client-only display data that should render immediately without flashing default values.
