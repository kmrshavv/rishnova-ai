<<<<<<< HEAD
# rishnova-ai
=======
# RishNova AI — beta deployment

RishNova keeps the existing vanilla HTML/CSS/JavaScript chat interface and uses
Supabase Auth, Supabase Postgres with Row Level Security (RLS), FastAPI, and a
local Ollama model. The intended beta path is:

`Browser (Cloudflare Pages) → FastAPI (Cloudflare Quick Tunnel) → local Ollama`

Supabase handles account authentication and database storage. The browser only
contains the Supabase **publishable/anon key**; FastAPI never uses a service-role
key and independently verifies Supabase access-token signatures before serving
private API routes. Database requests carry the user's verified token so
Postgres RLS is applied.

## What this deployment is — and is not

- Cloudflare Pages can host the static frontend on a free `*.pages.dev`
  hostname. No custom domain is needed.
- A **Quick Tunnel is temporary beta connectivity, not permanent backend
  hosting**. Its random hostname can change, and it stops when `cloudflared` or
  the laptop stops. After a hostname change, update `js/config.js` and redeploy
  the Pages site.
- Ollama and FastAPI bind to loopback. Ollama must not be exposed or port
  forwarded to the public internet.
- The Ryzen 5 5500U / 8 GB laptop is a single-user-scale inference host. Requests
  are serialized, use a 2,048-token context and at most 256 generated tokens,
  and unload the model after each response. Expect slow responses and downtime
  while the laptop sleeps, reboots, or loses internet.
- Rate limits and the admin-adjustable limits are **in-memory, per backend
  process**. They reset when FastAPI restarts and are not a durable quota or a
  substitute for production abuse protection. Use a durable shared limiter,
  monitored hosting, and an always-on backend before a broad public launch.
- Supabase free-tier email delivery, database limits, and availability are
  governed by Supabase's current plan and policies. Configure and test email
  verification/reset delivery before inviting users.

## 1. Prepare Supabase

1. Create a Supabase project and keep its database password private.
2. In **SQL Editor**, run these migrations in order:
   [`supabase/migrations/202611100001_initial_schema.sql`](./supabase/migrations/202611100001_initial_schema.sql)
   and [`supabase/migrations/202611100002_profile_rls_without_definer.sql`](./supabase/migrations/202611100002_profile_rls_without_definer.sql).
   They create `profiles`, `conversations`, and `messages`, enable RLS, and
   remove the legacy profile trigger. Profiles are created by the authenticated
   browser using a narrowly-scoped `auth.uid() = id` insert policy; there is no
   `SECURITY DEFINER` function.
3. In **Authentication → URL Configuration**, set **Site URL** to your deployed
   Pages URL. During local development, set it to `http://127.0.0.1:5500`.
   Add these **Redirect URLs**:
   - `http://127.0.0.1:5500/index.html` (the exact local confirmation callback)
   - `http://127.0.0.1:5500/**`
   - `http://localhost:5500/**`
   - `https://YOUR-PROJECT.pages.dev/**` (replace with your actual Pages URL)
   The frontend explicitly sends `http://127.0.0.1:5500/index.html` for signup
   confirmation and resend requests. Do not use `localhost:3000` or open the
   app as a `file://` URL. If email links still land on the wrong host, check
   the confirmation email template uses Supabase's `{{ .ConfirmationURL }}` and
   that the requested redirect URL is present in the allowlist. Keep email
   confirmation enabled.
   Emails already sent keep the redirect URL they were created with; changing
   the app or Supabase settings does not repair an old link. For an old link
   that targets `http://localhost:3000`, either run a local server on port 3000
   before opening it, or request a fresh confirmation link after configuring
   the new callback. Prefer the fresh link.
   Before production deployment, change `authRedirectUrl` in
   [`js/config.js`](./js/config.js) to
   `https://YOUR-PROJECT.pages.dev/index.html` and allowlist that URL.
4. In **Authentication → Providers → Email**, enable email/password sign-in and
   turn on email confirmation. Keep the confirmation and password recovery email
   templates enabled; their links must honor the requested redirect URL.
   Supabase returning success from `resend()` means the request was accepted,
   not that Gmail received it. If no new message arrives after a few minutes,
   inspect **Logs → Auth** for delivery or rate-limit errors and configure a
   custom SMTP provider under **Project Settings → Authentication → SMTP
   Settings**. Avoid repeatedly clicking resend; provider rate limits can
   suppress further messages.
5. The configured project URL and public **publishable key** are in
   [`js/config.js`](./js/config.js). The publishable key is intended for browser
   use. Never put a secret/service-role key or database password in frontend
   code or `.env`.
6. For backend JWT validation, use an asymmetric Supabase Auth signing key
   (ES256, ES384, RS256, or EdDSA). If the project still issues legacy HS256
   tokens, FastAPI verifies them by calling Supabase Auth's `/auth/v1/user`
   endpoint; it never decodes HS256 tokens without verification.

The migrations limit profile inserts to the signed-in user's `id`, and limit
profile updates to `full_name` and `avatar_url`. Conversation/message policies
and foreign keys prevent cross-user data access.

## 2. Configure and run on Windows 11

Install Ollama and Cloudflare `cloudflared` on the laptop. In PowerShell, from
the project folder:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
ollama pull qwen3.5:0.8b
ollama list
```

The Supabase URL, JWKS endpoint, and public publishable key are already filled
in the example. Set the Pages-site URL and admin email. The publishable key is
public and may be committed in the example; do not put secret keys here. Set
`RISHNOVA_CORS_ORIGINS` to the exact
Pages origin, for example `https://your-project.pages.dev` (no path or trailing
slash). Keep `RISHNOVA_ALLOWED_MODELS=qwen3.5:0.8b` for the default beta model.
The backend rejects non-loopback `OLLAMA_HOST` values.

[`js/config.js`](./js/config.js) is already configured for the supplied Supabase
project and its public publishable key. Only update `backendUrl` when switching
between local FastAPI and the current Quick Tunnel URL.
[`js/supabase.js`](./js/supabase.js) creates one client with persistent
sessions, automatic refresh, and URL callback detection. The publishable key is
expected to be visible in browser code. Do **not** put a Supabase secret key,
service-role key, or database password in frontend files.

Open three PowerShell terminals in the project folder:

**Terminal 1 — Ollama:** launch the Ollama Windows application (it normally
starts its local service). Confirm `ollama list` shows `qwen3.5:0.8b`. If the
service is not running, start `ollama serve` in this terminal.

**Terminal 2 — FastAPI:**

```powershell
backend\venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

**Terminal 3 — public beta tunnel:**

```powershell
cloudflared tunnel --url http://127.0.0.1:8000
```

Copy the `https://....trycloudflare.com` hostname printed by `cloudflared` into
`backendUrl` in `js/config.js`, then deploy that change to Pages. FastAPI's CORS
origin remains the **Pages site URL**, not the tunnel URL. The shipped
`_headers` CSP permits Quick Tunnel hostnames; if using another backend
hostname, add that exact HTTPS origin to its `connect-src` directive. Do not
bind FastAPI or Ollama to `0.0.0.0`, create router port forwards, or publish
port 11434.

For local frontend testing, open this folder in VS Code and use the Live Server
extension. The workspace settings bind it to `127.0.0.1:5500`; install
`ritwickdey.LiveServer` if needed, then right-click `index.html` and choose
**Open with Live Server**. Verify the browser address is
`http://127.0.0.1:5500/index.html`. Do not double-click the HTML file or use
`file://`. Alternatively, a simple static server can be used:

```powershell
python -m http.server 5500 --bind 127.0.0.1
```

Open `http://127.0.0.1:5500/index.html`. Temporarily set `.env`'s
`RISHNOVA_CORS_ORIGINS=http://127.0.0.1:5500,http://localhost:5500` and `FRONTEND_URL` to that same
origin, then restart FastAPI. `js/config.js` is configured for the supplied
Supabase project and local API by default.

## 3. Publish through GitHub and Cloudflare Pages

1. Create a private or public GitHub repository. From the project folder:

   ```powershell
   git init
   git add .
   git status --short
   ```

   Confirm `.env`, `venv`, and `backend/venv` are absent from the staged files.
   Then connect and push to your empty GitHub repository:

   ```powershell
   git commit -m "Prepare RishNova beta deployment"
   git branch -M main
   git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
   git push -u origin main
   ```

   Do not commit credentials.
2. In Cloudflare, choose **Workers & Pages → Create → Pages → Connect to Git**,
   authorize the repository, and configure:
   - Production branch: your default branch
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `/` (repository root)
3. Deploy. The site uses the `https://<project>.pages.dev` hostname. Add that
   exact hostname to `.env` as `FRONTEND_URL` and
   `RISHNOVA_CORS_ORIGINS`, restart FastAPI, and add it to Supabase's allowed
   redirect URLs and site URL.
4. Confirm the configured Supabase URL/public key and set the current tunnel
   URL in `js/config.js`, commit, and push. Cloudflare Pages redeploys the static site.
   The Supabase browser key is public; no backend secrets belong in Pages
   assets.
5. Test signup, confirmation email, login, reset email, and logout from the
   deployed HTTPS hostname. A temporary tunnel hostname change requires another
   `js/config.js` update and Pages deployment.

GitHub Pages is not needed; Cloudflare Pages serves the static site. The Python
backend is not deployed to Pages and stays on the laptop during this beta.

## API and protections

- Public: `GET /api/health` (only reports Ollama availability).
- JWT-protected: models, chat, profiles, usage, conversations, and admin limits.
- JWTs are signature-, algorithm-, issuer-, audience-, and expiry-validated
  against the Supabase JWKS endpoint for asymmetric keys. Legacy HS256 tokens
  are checked against Supabase Auth's authenticated user endpoint instead.
- PostgREST is called with the user's JWT and public key, not an elevated key;
  database policies remain the source of truth for row ownership.
- AI inputs are bounded (4,000 characters per message, 16,000 combined stored
  context characters, at most 24 client messages), responses are capped at 256
  tokens, and only the approved model allowlist is accepted.
- A single inference slot, short queue wait, request-size cap, CORS allowlist,
  security headers, per-user/minute and daily limits, and per-IP limits are
  configured in FastAPI.
- Admin limits are adjustable in the profile menu for email addresses listed
  in `RISHNOVA_ADMIN_EMAILS`. Runtime changes reset on restart; environment
  values in `.env` are the startup defaults.
- Quick Tunnel makes the backend hostname publicly reachable. Private routes
  still require a valid Supabase access token; the Quick Tunnel itself is not a
  durable or private network boundary.

## Security test checklist

After configuring a Supabase project and running both migrations:

- [ ] Sign up, verify email, log in, reload (session persists), reset password,
      and log out.
- [ ] `GET /api/health` works without a token; `GET /api/models` and
      `POST /api/chat` without a token return `401`.
- [ ] A malformed, expired, wrong-issuer, or wrong-audience token is rejected.
- [ ] Create two test users. Verify each only sees/updates/deletes its own
      profile, conversations, and messages; try the other user's UUID directly
      against the API and Supabase REST API.
- [ ] Confirm RLS is enabled on all three public tables and test the policies
      while authenticated as each test user.
- [ ] Send invalid/oversize messages, an unapproved model, and enough requests
      to hit the per-minute/daily/IP limits; check for 4xx responses and no
      stack traces.
- [ ] Verify non-admins receive `403` on `/api/admin/limits`; verify the
      configured admin can set bounded limits.
- [ ] Stop Ollama and confirm the API gives a useful sanitized error. Start it,
      then send a real prompt and verify the reply is generated by the installed
      `qwen3.5:0.8b` model.
- [ ] Confirm FastAPI listens only on `127.0.0.1:8000`, Ollama only on
      `127.0.0.1:11434`, HTTPS works for Pages/tunnel, and no secret/service
      role key appears in repository history or frontend assets.

## Authentication test walkthrough

1. Start Ollama, FastAPI, and the frontend as described above; open
   `http://127.0.0.1:5500`.
2. Choose **New to RishNova? Create an account**, enter full name, email,
   password (at least 8 characters), and matching confirmation. Confirm the
   verification email; its redirect returns to the same app. If the link
   expires, open it in the same browser and use **Resend confirmation email**
   (60-second UI cooldown), or enter your registration email and resend.
   After confirmation, the app displays the success message; choose **Continue
   to RishNova AI** to restore the confirmed session and open the dashboard.
3. Sign in with the verified email and password. Refresh: the Supabase session
   should restore and the chat dashboard should remain protected behind it.
4. Try an incorrect password and a duplicate registration; both should show a
   useful message without entering the dashboard.
5. Use **Forgot password?**, follow the recovery email link, set a new password,
   then sign in again.
6. Sign out from the profile menu. The dashboard should disappear; reopening or
   refreshing the app should show the login screen.
7. Test a valid/expired/wrong-issuer signed JWT with
   `backend\venv\Scripts\python.exe -m unittest discover -s tests -v`. For real
   cross-account RLS, use two verified test users in the live project and
   attempt to read one user's row while authenticated as the other.

The backend tests use test signing keys for unit coverage; they are not mock
Supabase sign-ins. Live user creation, confirmation, reset-email delivery, and
two-user RLS checks must be verified against your Supabase project before
claiming the authentication rollout is complete.

Run local backend checks from the project folder:

```powershell
backend\venv\Scripts\python.exe -m unittest discover -s tests -v
backend\venv\Scripts\python.exe -m py_compile backend\main.py
```

These local checks cannot verify your Supabase project, email delivery, RLS in
that project, public tunnel, or actual Ollama inference without your configured
services. Do not treat deployment as complete until the checklist's live
integration checks pass.
>>>>>>> 9f42d7b (Prepare RishNova AI for deployment)
