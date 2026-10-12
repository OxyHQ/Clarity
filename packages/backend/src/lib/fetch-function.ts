/**
 * What an injected `fetch` has to be: the call, and nothing else.
 *
 * The backend runs on Bun, whose `typeof fetch` also carries `preconnect`.
 * Nothing that takes a fetch here calls it, so asking for `typeof fetch` only
 * forced every test double to fake a method no caller uses.
 */
export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
