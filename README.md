# Astro Commerce Core

**Auditable order state transitions, margin-aware pricing and fail-closed runtime gates in TypeScript.**

A portfolio extraction of five domain packages from my larger Astro Commerce application. This repository is intentionally an offline engineering sample: it contains no payment processor, supplier or messaging adapter, live store, customer database or production credentials.

## What to review first

| Area | Code | Engineering decision |
| --- | --- | --- |
| Order lifecycle | `packages/commerce-core/src/order-state.ts` | Validate transitions and persist state plus history atomically; repeated transitions are idempotent |
| Pricing | `packages/pricing-engine/src/index.ts` | Search for a margin floor before applying price endings and competitor positioning |
| Unit economics | `packages/cashflow-engine/src/index.ts` | Separate gross receipts, costs, reserves and estimated margin |
| Runtime safety | `packages/commerce-core/src/mode.ts` | Require explicit owner identity and readiness checks before enabling LIVE |
| Persistence | `packages/db/src/index.ts` | SQLite, migrations, audited settings and testable database boundaries |

## Run and verify

Requires **Node.js 24 or later** for the built-in SQLite API.

```sh
npm ci
npm test
npm run typecheck
```

Verification on 2026-09-15: **23 tests passed across five test files; TypeScript check passed** on Node.js 24.18.0. These results apply only to the packages published here.

The test suite uses in-memory or temporary databases and fictional fixtures. Test strings resembling API keys are deliberate dummy values for redaction and readiness checks, not credentials. No real payment or message is sent by this extraction.

## Architecture

```text
shared-types
    | 
    +--> db --> commerce-core --> cashflow-engine --> pricing-engine
```

Packages are linked through npm workspaces. Source imports and core behavior are retained from the original application; the portfolio adds a minimal standalone test/typecheck harness. Commercial data, deployment scripts, production history and unrelated application code are excluded.

## Scope and limitations

- Passing the included tests is not a production certification, a legal compliance assessment or proof of revenue.
- Pricing and tax inputs are configurable model assumptions, not financial or tax advice.
- Readiness checks are application controls; they do not replace provider security, operational review or legal requirements.
- This extraction does not include a storefront, autonomous worker or external integrations.

**Alexander Ruiz** · Portugal · Web development, automation and technical support.

[GitHub](https://github.com/orliker) · [LinkedIn](https://www.linkedin.com/in/alexander-ruiz-7a64b8288/)
