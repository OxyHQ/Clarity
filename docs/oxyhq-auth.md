# OxyHQ Authentication & Packages Guide

This document explains which OxyHQ packages to use for each platform and provides integration examples.

## Decision Tree: Which Package Should I Use?

```
Are you building...
|-- A web app (React, Next.js, Vite)?
|   -> Use @oxyhq/services + @oxyhq/core
|
|-- A mobile app (Expo, React Native)?
|   -> Use @oxyhq/services + @oxyhq/core
|
|-- A backend (Node.js, Express)?
    -> Use @oxyhq/core only
```

---

## Package Selection by Platform

### Web Apps (React, Next.js, Vite)

**Packages:** `@oxyhq/services` + `@oxyhq/core`

Device-first session transport: wrap the app in `OxyProvider`, register your app's `clientId`, and use `useAuth` / `useOxy` for state.

```tsx
import { OxyProvider, useAuth } from '@oxyhq/services';

export default function App() {
  return (
    <OxyProvider baseURL="https://api.oxy.so" clientId={import.meta.env.VITE_OXY_CLIENT_ID}>
      <SignInButton />
    </OxyProvider>
  );
}

function SignInButton() {
  const { isAuthenticated, signIn, user } = useAuth();
  if (isAuthenticated) return <span>Hello, {user?.username}</span>;
  return <button type="button" onClick={() => signIn()}>Sign in with Oxy</button>;
}
```

### Mobile Apps (Expo, React Native)

**Packages:** `@oxyhq/services` + `@oxyhq/core`

Same provider and hooks as web — no separate web auth package.

```tsx
import { OxyProvider, useOxy } from '@oxyhq/services';

<OxyProvider
  baseURL="https://api.oxy.so"
  clientId="oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a"
>
  <App />
</OxyProvider>
```

### Backend (Node.js, Express)

**Packages:** `@oxyhq/core` only (import server helpers from `@oxyhq/core/server`)

```ts
import { createOxyAuthMiddleware, getRequiredOxyUserId } from '@oxyhq/core/server';
```

---

## Anti-patterns

### Don't use `@oxyhq/services` in backend

UI/session hooks belong in frontend apps only. Backend code uses `@oxyhq/core/server`.

### Don't hand-roll session restore or OAuth redirects in apps

`OxyProvider` owns device-first cold boot and in-app sign-in (`OxyAccountDialog`). RP apps do not redirect to `auth.oxy.so` for first-party sign-in.

---

## Clarity

Clarity uses `@oxyhq/services` on web and native via `OxyProvider` in `packages/frontend/app/_layout.tsx`, with `@oxyhq/core` on the API.
