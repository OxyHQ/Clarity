/**
 * Who Clarity's backend IS to Oxy: the project account that owns it, its two
 * applications and the workload identity its ECS tasks attest.
 *
 * Every value is an opaque primary key and is matched byte for byte; nothing
 * here is discovered by name, list position or order, or accepted from a
 * client.
 *
 * Clarity's assistant is not here. It is an ordinary Alia agent owned by the
 * project account below (Alia ADR 0020), confined to Clarity by Oxy (Oxy ADR
 * 0044), and the frontend opens it by id through `@alia.onl/sdk`. The backend
 * never calls Alia.
 */
export const CLARITY_IDENTITY = Object.freeze({
  projectAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
  /** The sign-in application the frontend's `OxyProvider` uses. Session reads only. */
  publicApplication: Object.freeze({
    applicationId: '01a0646a-2382-74a3-a795-788924d55722',
    credentialId: '01a0646e-2508-7048-8c08-b1f7b3af634f',
    clientId: 'oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a',
    scopes: Object.freeze(['user:read'] as const),
  }),
  backendApplication: Object.freeze({
    applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
    /**
     * The exact scope set of the backend's service token, and why each is there:
     *
     *  - `user:read` — Oxy account and organization reads (experience, Stripe customers);
     *  - `inference:invoke` — search embeddings on `kaana.ai` (`kaana-embeddings.ts`), the
     *    one inference call Clarity makes; chat is the person's, through Alia;
     *  - `catalogs:write` — registering the capability catalogue at startup
     *    (with the application capability `catalog:clarity`);
     *  - `capabilities:read` — live introspection of every capability ticket `/_oxy/mcp` admits;
     *  - `capability-audit:write` — the audit record of every `/_oxy/mcp` call.
     */
    scopes: Object.freeze([
      'user:read',
      'inference:invoke',
      'catalogs:write',
      'capabilities:read',
      'capability-audit:write',
    ] as const),
  }),
  /**
   * How this backend proves what it IS when it carries no credential (oxy ADR
   * 0026). The task signs an STS `GetCallerIdentity` request with its ECS task
   * role; Oxy replays it, canonicalises the role ARN, and mints the service
   * token — carrying `attestationId` as the token's `credentialId`.
   *
   * `attestationId` is pinnable because it is a pure function of `roleArn` and
   * of nothing else: `wl_` + 96 bits of SHA-256 over the canonical ARN. Every
   * task of this role, across every deploy, produces this one value. The
   * service-auth test recomputes it from `roleArn` rather than trusting the
   * literal, so a change to either reddens instead of silently rejecting every
   * token Clarity mints.
   */
  workloadIdentity: Object.freeze({
    provider: 'aws-iam',
    roleArn: 'arn:aws:iam::237343248947:role/oxy-clarity-task',
    attestationId: 'wl_1553bb11eb957512b3cdc956',
  }),
});
