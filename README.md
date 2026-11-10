# RishNova AI — deployment

RishNova uses the existing vanilla HTML/CSS/JavaScript chat interface,
Supabase Auth, Supabase Postgres with Row Level Security (RLS), FastAPI, and
Ollama. The production architecture is:

`Browser (Cloudflare Pages) → Pages Function (/api proxy) → Cloudflare Tunnel → FastAPI → loopback Ollama`

For the Oracle Cloud Ubuntu ARM64 setup, systemd services, named Tunnel, Pages
environment binding, backup, and recovery instructions, see
[CLOUD_DEPLOYMENT.md](./CLOUD_DEPLOYMENT.md). The Windows instructions below
are for local development and optional temporary beta testing; they do not
keep production AI online.

Supabase handles account authentication and database storage. The browser only
contains the Supabase **publishable/anon key**; FastAPI never uses a service-role
key and independently verifies Supabase access-token signatures before serving
private API routes. Database requests carry the user's verified token so
Postgres RLS is applied.

## Architecture and security notes

- Cloudflare Pages can host the static frontend on a free `*.pages.dev`
  hostname. No custom domain is needed.
- A stable named Cloudflare Tunnel requires a DNS domain managed in Cloudflare;
  the `.pages.dev` hostname itself cannot provide a tunnel DNS route. A Quick
  Tunnel is temporary and should not be used as the production API address.
- Production API requests use the same-origin Pages `/api` Function. Set its
  `BACKEND_API_URL` runtime variable to the HTTPS API origin; deployments do
  not require editing browser source to change backend hosts.
- Ollama and FastAPI bind to loopback. Ollama must not be exposed or port
  forwarded to the public internet.
- The backend serializes inference, uses a 2,048-token context and at most 256
  generated tokens, and keeps the single configured model loaded until Ollama
  stops. Performance depends on the host's available memory and CPU.
- Rate limits and the admin-adjustable limits are **in-memory, per backend
  process**. They reset when FastAPI restarts and are not a durable quota or a
  substitute for production abuse protection. Use a durable shared limiter,
  monitored hosting, and an always-on backend before a broad public launch.
- Supabase free-tier email delivery, database limits, and availability are
  governed by Supabase's current plan and policies. Configure and test email
  verification/reset delivery before inviting users.

## 1. Prepare Supabase

1. Keep the existing Supabase database password private.
2. The `profiles`, `conversations`, and `messages` tables already exist in this
   project. Do not rerun the initial table-creation migrations against this
   database. Confirm each table has RLS enabled and the ownership policies
   described in the existing migrations.
3. In **SQL Editor**, run
   [`supabase/migrations/202611100003_private_user_uploads.sql`](./supabase/migrations/202611100003_private_user_uploads.sql)
   once to prepare the private `rishnova-private-uploads` bucket. This does not
   create or alter the three application tables.
4. In **Authentication → URL Configuration**, set **Site URL** to
   `https://rishnova-ai.pages.dev`. During local development, set it to
   `http://127.0.0.1:5500`.
   Add these **Redirect URLs**:
   - `https://rishnova-ai.pages.dev/index.html`
   - `https://rishnova-ai.pages.dev/**`
   - `http://127.0.0.1:5500/index.html` (the exact local confirmation callback)
   - `http://127.0.0.1:5500/**`
   - `http://localhost:5500/**`
   The frontend builds signup, confirmation, resend, and recovery callbacks
   from the current origin. Do not use `localhost:3000` or open the app as a
   `file://` URL. If email links still land on the wrong host, check
   the confirmation email template uses Supabase's `{{ .ConfirmationURL }}` and
   that the requested redirect URL is present in the allowlist. Keep email
   confirmation enabled.
   Emails already sent keep the redirect URL they were created with; changing
   the app or Supabase settings does not repair an old link. For an old link
   that targets `http://localhost:3000`, either run a local server on port 3000
   before opening it, or request a fresh confirmation link after configuring
   the new callback. Prefer the fresh link.
   The auth callback is generated from the current site origin, so production
   signup and recovery links use the Pages hostname rather than a localhost URL.
5. In **Authentication → Providers → Email**, enable email/password sign-in and
   turn on email confirmation. Keep the confirmation and password recovery email
   templates enabled; their links must honor the requested redirect URL.
   Supabase returning success from `resend()` means the request was accepted,
   not that Gmail received it. If no new message arrives after a few minutes,
   inspect **Logs → Auth** for delivery or rate-limit errors and configure a
   custom SMTP provider under **Project Settings → Authentication → SMTP
   Settings**. Avoid repeatedly clicking resend; provider rate limits can
   suppress further messages.
6. The configured project URL and public **publishable key** are in
   [`js/config.js`](./js/config.js). The publishable key is intended for browser
   use. Never put a secret/service-role key or database password in frontend
   code or `.env`.
7. For backend JWT validation, use an asymmetric Supabase Auth signing key
   (ES256, ES384, RS256, or EdDSA). If the project still issues legacy HS256
   tokens, FastAPI verifies them by calling Supabase Auth's `/auth/v1/user`
   endpoint; it never decodes HS256 tokens without verification.

The backend sends each request to Supabase PostgREST with the signed-in user's
verified access token; the backend derives `user_id` from that verified token,
never from a browser-supplied owner ID. RLS and the composite message foreign
key enforce ownership. Conversation rows and messages are read from and written
to Postgres; LocalStorage is limited to interface preferences. Existing
`rishnova-ai:v1` browser data is left untouched as a legacy backup and is not
automatically imported because it has no trustworthy account ownership marker.

## 2. Configure and run locally on Windows 11

For automatic Windows startup, a named Cloudflare Tunnel, operational checks,
and safe removal, see the [self-hosted cloud server guide](./CLOUD_SERVER_SETUP.md).

For the cloud-hosted production deployment, follow
[CLOUD_DEPLOYMENT.md](./CLOUD_DEPLOYMENT.md). These Windows steps run a local
development API and Ollama; they are not required for public AI chat once the
cloud backend is configured.

Install Ollama on the laptop. In PowerShell, from the project folder:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
ollama pull qwen3.5:0.8b
ollama list
```

The Supabase URL, JWKS endpoint, and public publishable key are already filled
in the example. Set the admin email. The publishable key is public and may be
committed in the example; do not put secret keys here. `CORS_ALLOWED_ORIGINS`
includes the Pages origin and loopback development origins; on the cloud VM,
allow only `https://rishnova-ai.pages.dev`. Keep
`RISHNOVA_ALLOWED_MODELS=qwen3.5:0.8b` for the default beta model.
The backend rejects non-loopback `OLLAMA_URL` values.

The production frontend is hosted at `https://rishnova-ai.pages.dev`. It needs
no frontend build command. Its Supabase publishable key and environment-aware
auth redirect are configured in [`js/config.js`](./js/config.js); the Pages
Function forwards production `/api` requests to the `BACKEND_API_URL` set in
Cloudflare. Local hosts use `http://127.0.0.1:8000`. Never configure the
production Pages variable to point to localhost.
[`js/supabase.js`](./js/supabase.js) creates one client with persistent
sessions, automatic refresh, and URL callback detection. The publishable key is
expected to be visible in browser code. Do **not** put a Supabase secret key,
service-role key, or database password in frontend files.

Open two PowerShell terminals in the project folder:

**Terminal 1 — Ollama:** launch the Ollama Windows application (it normally
starts its local service). Confirm `ollama list` shows `qwen3.5:0.8b`. If the
service is not running, start `ollama serve` in this terminal.

**Terminal 2 — FastAPI:**

```powershell
backend\venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

For local frontend testing, open this folder in VS Code and use the Live Server
extension. The workspace settings bind it to `127.0.0.1:5500`; install
`ritwickdey.LiveServer` if needed, then right-click `index.html` and choose
**Open with Live Server**. Verify the browser address is
`http://127.0.0.1:5500/index.html`. Do not double-click the HTML file or use
`file://`. Alternatively, a simple static server can be used:

```powershell
python -m http.server 5500 --bind 127.0.0.1
```

Open `http://127.0.0.1:5500/index.html`. Keep the loopback frontend origins in
`CORS_ALLOWED_ORIGINS` for local testing, then restart FastAPI after changing
the environment. `js/config.js` selects the local API only on localhost and
127.0.0.1.

## 3. Publish through GitHub and Cloudflare Pages

1. The source repository is `https://github.com/kmrshavv/rishnova-ai.git`.
   From the project folder, review and push the intended changes:

   ```powershell
   git status --short
   git add .env.example .gitignore README.md CLOUD_DEPLOYMENT.md js backend tests supabase functions index.html _headers assets css
   git status --short
   ```

   Confirm `.env`, `venv`, `backend/venv`, and `.wrangler` are absent from the
   staged files. Then commit and push to the configured `origin`:

   ```powershell
   git commit -m "Configure RishNova production deployment"
   git push -u origin main
   ```

   Do not commit credentials. `.env.example` contains only the public Supabase
   publishable key and backend configuration defaults.
2. In Cloudflare, choose **Workers & Pages → Create → Pages → Connect to Git**,
   authorize the repository, and configure:
   - Production branch: your default branch
   - Framework preset: **None**
   - Build command: leave empty
   - Build output directory: `/` (repository root)
3. Set `CORS_ALLOWED_ORIGINS=https://rishnova-ai.pages.dev` on the cloud
   backend, and add the production hostname to Supabase's allowed redirect
   URLs and Site URL.
4. Set the Pages production runtime variable `BACKEND_API_URL` to the HTTPS
   origin for the Cloudflare Tunnel (for example `https://api.example.com`).
   Deploy the repository with its `functions/` directory so `/api` requests
   are proxied to that origin.
   The Supabase browser key is public; no backend secrets belong in Pages
   assets.
5. Test signup, confirmation email, login, reset email, logout, authenticated
   chat, and conversation history from the deployed HTTPS hostname. A tunnel
   origin change requires updating the Pages variable and redeploying, not
   editing `js/config.js`.

GitHub Pages is not needed; Cloudflare Pages serves the static site. FastAPI
and Ollama run on the cloud VM for production and may also run on a developer's
computer for local development.

## Cloud conversation behavior

- On authenticated startup, the backend fetches this user's profile,
  conversations, messages, and usage with the current Supabase access token.
- New conversations are created in Postgres before chat generation. FastAPI
  saves each user message and successful AI response; conversation activity
  updates `updated_at`. Rename and delete use owner-filtered backend endpoints.
  The existing Supabase `conversations` table has no `pinned` or `project`
  columns, so those interface preferences are stored locally per authenticated
  user and do not sync across devices.
- Conversation content is no longer written to LocalStorage. Only UI
  preferences are stored locally. Old `rishnova-ai:v1` data is retained as a
  local backup but is not automatically imported, because the old format did
  not record a trusted account owner.
- `window.RishNovaUploads` provides authenticated, private upload, signed-URL,
  and delete helpers for PDF/JPEG/PNG/WebP files up to 10 MB. The private
  Storage bucket and `storage.objects` RLS policies must be installed with the
  migration above before calling these helpers. The current attachment UI does
  not upload file contents yet.

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

After configuring a Supabase project, verify the existing table/RLS setup, and
run the private Storage migration:

- [ ] Sign up, verify email, log in, reload (session persists), reset password,
      and log out.
- [ ] `GET /api/health` works without a token; `GET /api/models` and
      `POST /api/chat` without a token return `401`.
- [ ] A malformed, expired, wrong-issuer, or wrong-audience token is rejected.
- [ ] Create two test users. Verify each only sees/updates/deletes its own
      profile, conversations, and messages; try the other user's UUID directly
      against the API and Supabase REST API.
- [ ] Create, rename, load, and delete a conversation; refresh and sign in from
      a second browser to verify the changes came from cloud Postgres.
- [ ] Verify `rishnova-private-uploads` is private and a signed-in user can
      access only objects beneath their own user-ID folder.
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
