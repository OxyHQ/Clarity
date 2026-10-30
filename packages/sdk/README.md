# Clarity SDK

External clients use `new ClarityClient({ apiKey })` with a scoped Oxy API key.
API keys retain their external scopes and quotas even when issued for an Oxy app.

Own backend integrations use the shared workload transport:

```ts
import { clarityForOxyService } from '@clarity.surf/sdk/server';

const clarity = clarityForOxyService(oxyServer);
await clarity.search({ query: 'public information' });
```

`oxyServer` is the caller's existing `OxyServer`. The factory selects Clarity's
recipient audience, `oxy-service:01a0648b-8d73-70ad-8e67-1c07ddc5eb6e`.
Oxy owns workload attestation, bearer refresh, origin restrictions and retries.
No key or scope list belongs in this integration.

Frontend integrations use the current provider's `oxyServices`:

```ts
import { clarityForOxySession } from '@clarity.surf/sdk';

const clarity = clarityForOxySession(oxyServices);
await clarity.experience.list(profileAccountId);
// On the owning component/client's disposal:
clarity.dispose();
```

The linked transport retains session switching and refresh. Do not read or copy
`http.getAccessToken()` or wrap fetch with application-local Authorization logic.
Personal Experience writes still require the authenticated account; workload
identity does not select a person's account. Public and external client APIs
remain available through `ClarityClient`.

The factories are source changes pending release. Deploy the matching Clarity
receiver and Oxy authority API before adopting the service factory in callers.

Public reads need no credential at all. Discover's news is the same for every
reader, so a screen with no reason to identify anyone (a photo frame, a kiosk)
reads it with a client constructed with none:

```ts
import { ClarityClient } from '@clarity.surf/sdk';

const stories = await new ClarityClient().publicNews({ languages: ['es', 'en'], limit: 10 });
const [article] = stories[0]?.articles ?? [];
// article.imageUrl is Clarity's copy of the image; article.imageSeeds, once
// known, are its seed colours (`#rrggbb`, best first) to theme a card with.
```
