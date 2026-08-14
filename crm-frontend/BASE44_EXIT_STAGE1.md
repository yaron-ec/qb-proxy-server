# Base44 Exit — Stage 1: Frontend Decoupling (CODE-ONLY / NON-PRODUCTION)

Stage 1 proves the existing CRM frontend can build and run independently of
Base44, using Railway authentication only. **No production change.** The live
Base44 build is untouched.

## What changed

| File | Change |
|---|---|
| `vite.config.js` | Converted to function form. `@base44/vite-plugin` is included **only** in default mode; excluded entirely in `--mode exit`. |
| `.env.exit` | New. Loaded by `vite --mode exit`. Sets `VITE_EXIT_BUILD=true` and `VITE_RAILWAY_API_URL` (operator fills in). |
| `package.json` | Added `dev:exit` and `build:exit` scripts. |
| `src/lib/app-params.js` | Added `isExitBuild` flag (gated on `VITE_EXIT_BUILD`). Base44 params untouched. |
| `src/lib/AuthContext.jsx` | Railway-only auth path when `isExitBuild`: no `base44.auth.me()`, no Base44 token, no Base44 settings. Login/logout route to `/login`. |
| `src/pages/Login.jsx` | New native login page → `POST /api/v1/auth/login` → Railway JWT → `GET /api/v1/auth/me`. |
| `src/App.jsx` | `/login` public route + exit-mode auth gate (`<Navigate to="/login">`). Base44 path unchanged. |

## What did NOT change (safety)

- `src/api/base44Client.js` — kept.
- `@base44/sdk`, `@base44/vite-plugin` in `package.json` — kept (live build needs them).
- All Base44 entities/functions/automations — untouched.
- `USE_RAILWAY_AUTH` flag and Base44 branch in AuthContext — untouched.
- Production env, DNS, QuickBooks, Railway deploy — untouched.

## Build commands

```bash
# Live Base44 build (unchanged)
npm run build

# Standalone exit build (no Base44 plugin)
npm run build:exit

# Local dev, exit mode
npm run dev:exit
```

Before running the exit build, copy `.env.exit` → `.env.exit.local` and set:
```
VITE_RAILWAY_API_URL=https://<your-railway-api-origin>
```

## Auth flow (exit build)

```
User opens CRM (no Railway token)
  → AuthContext.checkAppState (isExitBuild): no token → auth_required
  → App gate: <Navigate to="/login">
  → Login page: POST /api/v1/auth/login → { access, refresh }
  → tokens stored (localStorage) → checkAppState → GET /api/v1/auth/me → user
  → navigate("/") → CRM
```

Token refresh: `src/api/railway/client.js` auto-refreshes once on 401 via
`POST /api/v1/auth/refresh`; on refresh failure the caller re-authenticates.

## Validation status

- Build configured: `npm run build:exit` (operator runs).
- Login page compiles, Railway AuthContext compiles.
- `VITE_RAILWAY_API_URL` is the only API config (no Base44 app params).
- Runtime auth tests (login/refresh/logout) require a deployed Railway API +
  a test runner (vitest not installed); deferred. Manual smoke checklist below.

## Manual smoke checklist (operator, against staging Railway API)

1. `npm run build:exit` succeeds; `dist/` produced.
2. `npm run dev:exit`, no `VITE_RAILWAY_API_URL` → app loads, unauthenticated → `/login`.
3. Bad credentials → error shown, no redirect.
4. Valid credentials → tokens in localStorage, redirected to `/`, CRM renders.
5. Wait 16 min (access expiry) → next API call refreshes transparently.
6. Logout → tokens cleared, redirected to `/login`.

## Remaining Base44 dependencies

Business pages still call `base44.entities.*` / `base44.functions.*`. These are
intentionally NOT migrated in Stage 1 (page-by-page in later stages). See the
dependency inventory in the Stage 1 commit report.