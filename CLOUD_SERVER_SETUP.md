# RishNova AI self-hosted Windows server

This setup runs Ollama and FastAPI on the Windows laptop and uses a **named
Cloudflare Tunnel** to provide an HTTPS API hostname. It does not expose a
Windows port through the router and never tunnels Ollama. The existing
Cloudflare Pages frontend, Supabase authentication, RLS-protected Postgres
storage, and chat UI remain in place.

## Important prerequisite: a domain you control

A stable named Tunnel hostname requires a DNS domain in a Cloudflare account
you control. `rishnova-ai.pages.dev` is a Pages hostname, not a DNS zone you
can route a named Tunnel through. No API domain has been supplied or
configured, so this repository does **not** invent one or claim a stable
public API exists.

If you do not own a domain, the backend can still run locally, but the public
Pages website cannot reach the laptop. A Cloudflare Quick Tunnel is temporary:
its hostname can change, so the Pages `BACKEND_API_URL` must be updated and
Pages redeployed whenever it changes. This setup intentionally does not create
or rely on a Quick Tunnel.

## What this setup does

- At the current Windows user's sign-in, Task Scheduler starts one supervised
  process. No password is stored and administrator elevation is not required.
- The supervisor checks internet reachability, checks for an existing Ollama
  service/process/API before starting anything, verifies/downloads the one
  configured model, and sends a small warm-up request.
- It starts FastAPI only after the model is ready, bound to `127.0.0.1:8000`
  with one worker. It starts Cloudflare Tunnel only from a valid named-tunnel
  configuration and routes only to FastAPI.
- The supervisor monitors health, restarts exited managed backend/tunnel
  processes with delays, records rotating startup logs and status, and
  retries recoverable network/model failures with backoff.
- The browser checks backend availability without overlapping health checks.
  Failed health checks retry with exponential backoff capped at 60 seconds and
  display an offline message.
- On a Windows shutdown request, a marked Task Scheduler event trigger and its
  console handler request graceful shutdown. At user sign-out, the console
  handler requests the same cleanup.
  FastAPI is allowed up to 30 seconds; tunnel and supervisor-started Ollama
  also receive graceful stop requests before a targeted termination fallback.
  Windows can shorten or interrupt user-session tasks during shutdown, and a
  power loss cannot run cleanup. For a deliberate stop that waits for the full
  grace period, run `.\deployment\windows\stop-rishnova.ps1` before shutting
  down. A privileged Windows service with a preshutdown control handler would
  be needed for stronger OS-enforced shutdown ordering; this setup avoids
  installing such a service or storing an administrator credential.
- All API routes keep their existing Supabase JWT checks, request limits,
  rate limits, approved-model checks, and user-token/RLS persistence. The
  managed public deployment uses exact Pages-origin CORS and allows only
  `qwen3.5:0.8b`.

The scheduled task runs **at user sign-in**, not before anyone signs into
Windows. This avoids saving a Windows password or installing a privileged
service. Keep the laptop signed in and connected to the internet for the
public service to be available. Sleep, battery-saving settings, lid-close
behavior, ISP outages, and Windows updates can take it offline.

## Prerequisites and repository findings

The inspected project uses:

- `backend.main:app` as its FastAPI entry point.
- `backend\venv\Scripts\python.exe` and `backend\requirements.txt`.
- Ollama at `http://127.0.0.1:11434`, configured for
  `qwen3.5:0.8b`.
- `js/config.js` for local-vs-production API selection. Production browser
  requests use same-origin `/api`; `functions/api/[[path]].js` requires the
  Pages runtime variable `BACKEND_API_URL`.
- Supabase Auth JWT verification in FastAPI and the signed-in user's token for
  PostgREST operations. Existing RLS-protected conversations/messages remain
  the source of truth.

On the inspected laptop, `ollama.exe` and `cloudflared.exe` are installed; no
Ollama or RishNova Windows service or scheduled task was found. The scripts
still check for an Ollama Windows service and an existing API/process on each
startup to avoid starting a duplicate. The current production Pages
`/api/health` response was HTML rather than API JSON, so the hosted Pages
Function/runtime binding is not currently serving the backend.

Ensure `.env` exists and set `RISHNOVA_ADMIN_EMAILS` to the intended admin
email. The installer will create `.env` from `.env.example` if missing; review
the copied values before public use. Never place service-role keys, database
passwords, or tunnel credentials in browser code or Git. `.env` is ignored by
Git.

## One-time installation

Open PowerShell in `C:\Users\Rishav\Desktop\Risnovo` and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deployment\windows\install.ps1
```

This verifies the existing virtual environment, installs no new packages,
creates `logs\`, registers the current-user scheduled task idempotently, and
starts the supervisor. It does not require Administrator permissions. If a
required executable or Python dependency is missing, it reports that rather
than silently installing packages.

The installer registers `RishNova AI Server (User)` at sign-in and a separate
`RishNova AI Shutdown (User)` task triggered by the Windows shutdown-request
event. Both ignore duplicate instances or are triggered only once per shutdown
event. Re-running the installer updates those tasks only if their ownership
marker matches this project. A different task with either name is not
overwritten.

## One-time Cloudflare named Tunnel setup

1. Own a domain and add its DNS zone to the Cloudflare account you will use.
   Choose a hostname such as `api.your-domain.example` under that zone. Do
   **not** use `rishnova-ai.pages.dev`, `localhost`, or a `trycloudflare.com`
   hostname.
2. After installation, run the following in PowerShell, replacing the example
   with your actual hostname:

   ```powershell
   .\deployment\windows\configure-cloudflare.ps1 -ApiHostname api.your-domain.example
   ```

   If Cloudflare has not been authorized on this Windows account, the script
   invokes `cloudflared tunnel login`; complete its browser authorization.
   The script reuses the named tunnel `rishnova-ai` if present, otherwise
   creates it, creates the DNS route, verifies the credential file, writes a
   private config under `%LOCALAPPDATA%\RishNovaAI\cloudflared.yml`, validates
   its ingress, and wakes the supervisor. It does not write tunnel credentials
   into the repository.
3. In Cloudflare Pages, set the **production** runtime variable:

   ```text
   BACKEND_API_URL=https://api.your-domain.example
   ```

   Use only the origin (no `/api` path, credentials, query, or trailing route).
   Configure Preview separately if needed. Redeploy Pages so the Pages
   Function is deployed with the binding. Deploy the current repository
   version, including `functions/api/[[path]].js`; repository edits alone do
   not deploy the site.
4. In Supabase Auth URL Configuration, retain the Pages site URL and redirect
   URLs. Do not change them to the laptop's address. The supervisor configures
   production CORS as exactly `https://rishnova-ai.pages.dev`.
5. Check that the generated DNS record points to the named Tunnel in
   Cloudflare DNS. Do not add router port-forwarding/firewall ingress for
   `8000` or `11434`; neither port should listen on a public interface.

If you do not have a domain, stop after local installation. The public website
will report the backend offline until a reachable backend is configured.
Setting a temporary Quick Tunnel URL in Pages is possible for a short test but
is intentionally not automated; the URL is temporary and changing it requires
updating the Pages variable and redeploying.

## Startup, monitoring, and shutdown

The startup sequence is: internet check; reuse or start Ollama; wait for its
API; check model tags; download `qwen3.5:0.8b` only if absent; warm that model
with a one-token request; start/check FastAPI; then start/check the named
Tunnel. The one configured model remains loaded until shutdown. Ollama is
limited to one loaded model and single parallel execution by the supervisor
when it starts Ollama. Existing Ollama desktop/service processes are reused
rather than replaced.

Windows setup normally needs no commands after installation. These scripts
are available for recovery/diagnostics:

```powershell
.\deployment\windows\start-rishnova.ps1
.\deployment\windows\health-check.ps1
.\deployment\windows\stop-rishnova.ps1
```

The `start` script asks the existing supervisor to recover; it will not launch
a second supervisor. `stop` only stops processes started by the supervisor.
An Ollama desktop app or a separately installed Windows service remains owned
by its installer/Windows and is not force-stopped by this project's scripts.
Windows normally closes those apps/services as part of OS shutdown.

Logs are created in the ignored `logs\` directory:

- `startup.log`: orchestration, Ollama startup/download output, and retries.
- `backend.log`: FastAPI stdout/stderr.
- `tunnel.log`: Cloudflare Tunnel output.
- `health.log`: periodic component status snapshots.

The supervisor also stores its loopback-only control token and status under
`%LOCALAPPDATA%\RishNovaAI`. It binds its control endpoint only to
`127.0.0.1` and requires that token. No control port is routed through
Cloudflare.

## Verification

Local checks:

```powershell
.\deployment\windows\health-check.ps1
curl.exe --fail --silent http://127.0.0.1:11434/api/tags
curl.exe --fail --silent http://127.0.0.1:8000/health
curl.exe --fail --silent http://127.0.0.1:8000/health/ready
```

After named Tunnel and Pages configuration, verify:

```powershell
curl.exe --fail --silent https://api.your-domain.example/api/health
curl.exe --fail --silent https://rishnova-ai.pages.dev/api/health
Get-ScheduledTask -TaskName 'RishNova AI Server (User)' | Get-ScheduledTaskInfo
```

Then test Supabase signup/login, model discovery, a chat response, chat history
reload, and logout from the production Pages site. These require real Supabase
and Cloudflare configuration and cannot be verified solely by the local
health endpoint. Test a Windows restart and shutdown only after saving work;
the supervisor sends graceful termination to its own child processes and
waits before its targeted fallback.

## Security and operating limits

- FastAPI binds to loopback. Ollama must remain on loopback. The named Tunnel
  routes only to FastAPI; no router forwarding is used.
- The existing backend validates Supabase JWT signatures/claims and passes
  the verified user's token to PostgREST, so database RLS is applied. The
  browser contains only the Supabase publishable key, never a service-role
  key.
- Production CORS is exact Pages-origin only; request size, chat history,
  per-user/IP rates, and allowed model are bounded. The one-worker limit keeps
  existing in-memory rate accounting consistent.
- Public model health is deliberately minimal on `/health/ready`. Existing
  `/api/health` remains for frontend model availability and does not return
  secrets.
- Supabase chat data persists in PostgreSQL. In-memory rate counters and
  admin-adjusted limits reset when the backend restarts.
- A laptop is not an always-on server: sleep/hibernation, lid settings,
  battery, Wi-Fi/ISP outages, Windows updates, and user sign-out affect
  availability. Cloudflare Tunnel reconnects after network loss while its
  process remains running; the supervisor restarts it if it exits.
- The 8 GB Ryzen 5 5500U is CPU-only for this setup. `qwen3.5:0.8b` is much
  lighter than larger models, but Windows, Ollama, and inference share RAM and
  CPU. Inference latency and throughput are hardware/load dependent; avoid
  starting multiple models or increasing concurrency/context casually.

## Safe uninstall

Run:

```powershell
.\deployment\windows\uninstall.ps1
```

It requests graceful shutdown and removes only the marked RishNova startup and
shutdown scheduled tasks. It preserves logs, local tunnel configuration and
credentials, Ollama, downloaded models, the Cloudflare named tunnel/DNS record,
and all Supabase data. Remove Cloudflare resources separately in the Cloudflare
dashboard only if you intentionally want to retire them; the uninstall script
never deletes external resources.

## Troubleshooting

- **Ollama offline:** run `.\deployment\windows\health-check.ps1`; inspect
  `logs\startup.log`. Confirm Ollama is installed and listening on
  `127.0.0.1:11434`. The supervisor does not create a second instance when a
  service or Ollama process is already detected.
- **Model missing:** inspect `startup.log` for the one-time `ollama pull`.
  Confirm internet access and free disk space. The supervisor retries with
  backoff and does not pull again once the model appears in `/api/tags`.
- **FastAPI unavailable:** inspect `logs\backend.log`. Confirm
  `backend\venv\Scripts\python.exe` and `.env` are present. If port 8000 is
  held by an unhealthy process, the supervisor refuses to start a duplicate;
  identify that process before taking action.
- **Tunnel offline/not configured:** inspect `logs\tunnel.log` and the
  `LastStartupError` from `health-check.ps1`. Check Cloudflare DNS, the named
  tunnel credentials path, and the generated config. The supervisor retries
  exited tunnels; cloudflared itself reconnects transient network failures.
- **Pages `/api` returns HTML/503:** ensure the current Pages deployment
  includes `functions/api/[[path]].js`, `BACKEND_API_URL` is set in the
  production environment, and Pages was redeployed.
- **Pages `/api` returns 502:** first verify
  `https://api.your-domain.example/api/health`, then check Tunnel logs and DNS.
- **Login/chat data fails:** check Supabase Auth redirect allowlists, signing
  keys, database RLS policies, and the backend logs. Do not disable JWT
  validation or RLS to work around an error.
- **Startup task is missing:** rerun the installer. If a same-named task has
  no RishNova ownership description, the installer stops rather than
  overwriting it.
