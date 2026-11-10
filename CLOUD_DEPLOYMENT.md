# RishNova AI — Oracle Cloud ARM64 deployment

This guide moves inference off the development laptop. The target production
path is:

`Browser → Cloudflare Pages → Pages Function (/api proxy) → Cloudflare Tunnel → FastAPI → loopback Ollama`

Supabase Auth issues user sessions and Supabase Postgres stores profiles,
conversations, and messages under the existing row-level security (RLS)
policies. Do not recreate the application tables or use a database
service-role key. Deployment requires manual Oracle, Cloudflare, and Supabase
configuration; repository changes alone do not deploy the service.

## Prerequisites and important limits

- An Oracle Cloud Ubuntu ARM64 VM. Check current Always Free availability,
  regional capacity, quotas, and terms in your Oracle account; they can change.
- A DNS domain you control and have added to Cloudflare for a stable, named
  Cloudflare Tunnel hostname such as `api.example.com`. A `*.pages.dev`
  hostname is not a DNS zone you control and cannot be used to create the
  tunnel's stable DNS record.
- Access to this repository, the existing Supabase project, and the Cloudflare
  Pages project.
- SSH access through an Oracle security list or network security group. Do not
  open inbound ports 8000 or 11434. Neither service should listen on a public
  interface.

A Cloudflare Quick Tunnel provides a temporary hostname only. It is suitable
for a short test, not a stable production address. If you use one, set
`BACKEND_API_URL` in the Pages environment to its HTTPS origin and update that
setting whenever the tunnel hostname changes.

## 1. Prepare Supabase

1. Use the existing Supabase project URL and its public publishable key. The
   backend uses that key with the signed-in user's access token; the browser
   also needs the public key for Supabase Auth. The publishable key is not a
   database password. Never use a secret key, legacy service-role key, or
   database password in browser code or as the backend's database API key.
2. Keep the existing `profiles`, `conversations`, and `messages` tables and
   their RLS policies. Do not rerun
   `supabase/migrations/202611100001_initial_schema.sql` against the existing
   database.
3. If the private upload helpers are being used, run
   `supabase/migrations/202611100003_private_user_uploads.sql` once. It creates
   the private Storage bucket and its user-folder policies; it does not
   recreate application tables. The current attachment UI does not upload
   file contents.
4. In **Authentication → URL Configuration**, set the Site URL to
   `https://rishnova-ai.pages.dev` and allow
   `https://rishnova-ai.pages.dev/index.html` and
   `https://rishnova-ai.pages.dev/**` for redirects. Add local redirect URLs
   only when local signup or recovery testing is needed.
5. Keep email/password authentication and email confirmation enabled. Verify
   signup, confirmation, password recovery, login, and logout on the deployed
   Pages hostname.
6. In **Project Settings → API**, copy the project URL and the publishable
   key. In **Authentication → Signing Keys**, confirm the project's current
   JWT signing configuration. The backend accepts Supabase asymmetric signing
   keys through JWKS and verifies legacy HS256 tokens against Supabase Auth.

## 2. Create and secure the Oracle VM

1. Create an Ubuntu ARM64 instance in a region with capacity. Choose a shape
   with enough memory for Ubuntu, Ollama, and inference; model performance
   depends on the selected shape. Attach an appropriately sized boot volume.
2. Add only SSH ingress to the Oracle network security list. Restrict SSH to
   your administrator IP where practical. Do not add ingress rules for 8000,
   11434, 80, or 443 for this Tunnel-based setup.
3. Connect over SSH, then update the host and install the basic tools:

   ```bash
   sudo apt update
   sudo apt -y upgrade
   sudo apt install -y build-essential ca-certificates curl git python3 \
     python3-dev python3-venv python3-pip
   ```

4. Configure the Ubuntu firewall while preserving your actual SSH source:

   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw allow from YOUR_ADMIN_PUBLIC_IP to any port 22 proto tcp
   sudo ufw enable
   sudo ufw status verbose
   ```

   Replace the example IP and confirm a second SSH connection works before
   closing the original session. Oracle's network security list and the VM
   firewall both need to permit administrative SSH.

5. Create a non-login account for the API:

   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/rishnova \
     --shell /usr/sbin/nologin rishnova
   sudo install -d -o rishnova -g rishnova /opt/rishnova-ai
   ```

## 3. Install Ollama and the model

Install Ollama using its official Linux ARM64 instructions. The upstream
installer is convenient on Ubuntu:

```bash
curl -fsSL https://ollama.com/install.sh -o /tmp/install-ollama.sh
sed -n '1,200p' /tmp/install-ollama.sh
sudo sh /tmp/install-ollama.sh
rm /tmp/install-ollama.sh
```

Review downloaded installer scripts before running them. Then pin Ollama to
loopback using a systemd override:

```bash
sudo systemctl edit ollama
```

Add:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
```

Save, then download and verify the configured model:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl restart ollama
ollama pull qwen3.5:0.8b
ollama list
ss -ltn | grep ':11434'
curl --fail --silent http://127.0.0.1:11434/api/tags
```

The listener must be `127.0.0.1:11434`, not `0.0.0.0:11434`. Model weights
remain in Ollama's data directory and must never be committed to this Git
repository.

## 4. Install the FastAPI application

Put a reviewed checkout of this repository at `/opt/rishnova-ai`. For a private
repository, use a protected deploy key or another approved GitHub
authentication method; do not put a token in the clone URL or shell history.
Set the checkout's owner to the service account:

```bash
sudo chown -R rishnova:rishnova /opt/rishnova-ai
sudo -u rishnova python3 -m venv /opt/rishnova-ai/.venv
sudo -u rishnova /opt/rishnova-ai/.venv/bin/python -m pip install --upgrade pip
sudo -u rishnova /opt/rishnova-ai/.venv/bin/pip install \
  -r /opt/rishnova-ai/backend/requirements.txt
```

Create a root-owned environment file. Do not copy a developer's `.env` file
without reviewing each value:

```bash
sudo install -o root -g root -m 600 /dev/null /etc/rishnova.env
sudoedit /etc/rishnova.env
```

Set the following values, replacing every placeholder with the existing
project's values. For a production VM, allow only the production Pages origin;
add loopback development origins only to a separate development backend.

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
SUPABASE_JWKS_URL=https://YOUR_PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_JWT_ISSUER=https://YOUR_PROJECT_REF.supabase.co/auth/v1
SUPABASE_JWT_AUDIENCE=authenticated
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:0.8b
OLLAMA_REQUEST_TIMEOUT_SECONDS=180
CORS_ALLOWED_ORIGINS=https://rishnova-ai.pages.dev
RISHNOVA_ALLOWED_MODELS=qwen3.5:0.8b
RISHNOVA_ADMIN_EMAILS=YOUR_ADMIN_EMAIL
RISHNOVA_USER_RPM=6
RISHNOVA_DAILY_LIMIT=40
```

`SUPABASE_PUBLISHABLE_KEY` is used by the backend to call Supabase Auth and
PostgREST together with a verified user's access token. It is not a
service-role credential. Do not add a service-role key, database password, or
Ollama credential to this file.

Create `/etc/systemd/system/rishnova-api.service`:

```ini
[Unit]
Description=RishNova FastAPI backend
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=rishnova
Group=rishnova
WorkingDirectory=/opt/rishnova-ai
EnvironmentFile=/etc/rishnova.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/rishnova-ai/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

Enable the API and verify the health result:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rishnova-api
sudo systemctl status rishnova-api --no-pager
sudo journalctl -u rishnova-api -n 100 --no-pager
curl --fail --silent http://127.0.0.1:8000/api/health
ss -ltn | grep -E ':(8000|11434)\b'
```

Both application listeners must be loopback-only. Health reports Ollama
connectivity and whether the configured default model is installed. It does
not expose an unauthenticated chat or database endpoint.

## 5. Publish FastAPI through a named Cloudflare Tunnel

Use a domain whose DNS zone is managed by your Cloudflare account. Do not
publish ports 8000 or 11434 and do not point a public DNS record directly at
the VM.

1. Download the ARM64 `cloudflared` package from Cloudflare's official release
   page, verify the release source, and install it. For example:

   ```bash
   curl -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb \
     -o /tmp/cloudflared.deb
   sudo dpkg -i /tmp/cloudflared.deb
   cloudflared --version
   rm /tmp/cloudflared.deb
   ```

2. In an administrator shell with a browser available, authenticate and create
   a named tunnel. Protect the generated credentials file:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create rishnova-api
   cloudflared tunnel route dns rishnova-api api.example.com
   ```

   Replace `api.example.com` with a hostname in your Cloudflare-managed zone.
   Record the tunnel UUID and locate its generated JSON credentials file.
3. Create a dedicated service identity and install the config and credentials
   with restricted permissions:

   ```bash
   sudo useradd --system --home-dir /var/lib/cloudflared \
     --create-home --shell /usr/sbin/nologin cloudflared
   sudo install -o root -g cloudflared -m 750 -d /etc/cloudflared
   sudo install -o root -g cloudflared -m 640 \
     ~/.cloudflared/YOUR_TUNNEL_UUID.json \
     /etc/cloudflared/YOUR_TUNNEL_UUID.json
   sudoedit /etc/cloudflared/config.yml
   sudo chown root:cloudflared /etc/cloudflared/config.yml
   sudo chmod 640 /etc/cloudflared/config.yml
   ```

   Use this config:

   ```yaml
   tunnel: YOUR_TUNNEL_UUID
   credentials-file: /etc/cloudflared/YOUR_TUNNEL_UUID.json
   ingress:
     - hostname: api.example.com
       service: http://127.0.0.1:8000
     - service: http_status:404
   ```

4. Create `/etc/systemd/system/cloudflared-rishnova.service`:

   ```ini
   [Unit]
   Description=Cloudflare Tunnel for RishNova API
   After=network-online.target rishnova-api.service
   Wants=network-online.target rishnova-api.service

   [Service]
   Type=simple
   User=cloudflared
   Group=cloudflared
   ExecStart=/usr/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run rishnova-api
   Restart=on-failure
   RestartSec=5
   NoNewPrivileges=true
   PrivateTmp=true
   ProtectSystem=strict
   ProtectHome=true

   [Install]
   WantedBy=multi-user.target
   ```

5. Start and verify the tunnel:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared-rishnova
   sudo systemctl status cloudflared-rishnova --no-pager
   sudo journalctl -u cloudflared-rishnova -n 100 --no-pager
   curl --fail --silent https://api.example.com/api/health
   ```

   Cloudflare terminates public HTTPS and connects to the API over the tunnel.
   The origin remains `http://127.0.0.1:8000`; do not bind Uvicorn to a public
   interface or expose either local service.

## 6. Configure Cloudflare Pages

The production frontend calls the same-origin `/api/...` route. The Pages
Function in `functions/api/[[path]].js` proxies those requests to the configured
backend origin; the production hostname is not embedded in browser JavaScript.

1. Deploy this repository through the existing Cloudflare Pages Git
   integration, or another Pages deployment method that includes the
   `functions/` directory. Keep the existing static-site output settings; no
   frontend build step is required.
2. In the Pages project's **Settings → Variables and Secrets**, add the
   production runtime variable:

   ```text
   BACKEND_API_URL=https://api.example.com
   ```

   Use the backend origin only (no `/api` path, credentials, or trailing route).
   Set a separate value for Preview deployments if those previews should call
   a staging API, and allow the exact preview origin in that staging API's
   CORS configuration. Do not put database credentials, a Supabase
   service-role key, or tunnel credentials in Pages variables.
3. Redeploy Pages so the function and binding are active. The bundled
   `js/config.js` intentionally uses a same-origin API path in production.
   Local development uses `http://127.0.0.1:8000` and does not invoke the Pages
   Function.
4. Verify:

   ```bash
   curl --fail --silent https://rishnova-ai.pages.dev/api/health
   ```

   Then sign in on the Pages site and verify model discovery, chat completion,
   saved message history, and loading an earlier conversation. The API's
   `CORS_ALLOWED_ORIGINS` must contain the exact Pages origin and no wildcard.
   The Pages proxy is same-origin; direct API testing still uses the backend's
   CORS allowlist.

## 7. Smoke tests and operations

On the VM:

```bash
systemctl is-active ollama rishnova-api cloudflared-rishnova
ss -ltn | grep -E ':(8000|11434)\b'
curl --fail --silent http://127.0.0.1:8000/api/health
curl --fail --silent https://api.example.com/api/health
ollama list
```

Expected listeners are `127.0.0.1:8000` and `127.0.0.1:11434`. Only the
Cloudflare hostname should be reachable from the public internet.

In the Cloudflare Pages browser, test registration and email confirmation,
login, logout, session restoration after reload, chat, message persistence,
loading and deleting a prior conversation, and a forced backend-offline error.
Do not treat a successful `/api/health` response as proof that Supabase email
delivery, authenticated chat, or database persistence works.

The API currently returns a complete response rather than streaming tokens.
Rate and daily limits are in-memory and reset on process restart; keep one
Uvicorn worker for these existing limits. Use a shared durable limiter before
scaling to multiple processes or instances.

## 8. Troubleshooting

```bash
sudo systemctl status ollama rishnova-api cloudflared-rishnova --no-pager
sudo journalctl -u ollama -n 100 --no-pager
sudo journalctl -u rishnova-api -n 100 --no-pager
sudo journalctl -u cloudflared-rishnova -n 100 --no-pager
sudo ss -ltnp
curl -v http://127.0.0.1:11434/api/tags
curl -v http://127.0.0.1:8000/api/health
curl -v https://api.example.com/api/health
curl -v https://rishnova-ai.pages.dev/api/health
```

- **API health says `offline`:** check `ollama.service`, the loopback
  `OLLAMA_URL`, system memory/disk, and the Ollama journal.
- **Ollama is reachable but `model_available` is false:** check
  `OLLAMA_MODEL`, `RISHNOVA_ALLOWED_MODELS`, and `ollama list`; pull
  `qwen3.5:0.8b` if it is absent.
- **Tunnel hostname fails:** check the named tunnel service, Cloudflare DNS
  route, tunnel credentials permissions, and `cloudflared` logs. Confirm
  FastAPI is healthy on loopback first.
- **Pages `/api` returns 503:** set the Pages runtime variable
  `BACKEND_API_URL` to the HTTPS API origin, then redeploy.
- **Pages `/api` returns 502:** inspect Pages Function logs and verify the
  configured origin's `/api/health` endpoint.
- **Browser reports CORS:** confirm the origin is exactly
  `https://rishnova-ai.pages.dev`, check `CORS_ALLOWED_ORIGINS`, and restart
  FastAPI after environment changes. Do not use wildcard CORS.
- **401 / 403 responses:** confirm Supabase URL, JWKS endpoint, issuer,
  audience, signing-key configuration, user session, and RLS policies.
- **Chat fails after a user message appears:** inspect the API and database
  logs; the backend may have saved the user turn before inference failed.
  Retry only after checking whether it already exists in the conversation.

## 9. Backup and recovery

- Supabase owns the authoritative profile and conversation data. Review the
  backup/export features available for the current Supabase plan and schedule
  regular database exports. Store exports encrypted and off the VM. For a
  manual export, install `postgresql-client` and use a database connection
  host and username from Supabase. `-W` prompts for the password without
  putting it in the command line:

  ```bash
  sudo apt install -y postgresql-client gnupg
  umask 077
  backup_file="$HOME/rishnova-$(date -u +%Y%m%dT%H%M%SZ).dump"
  PGSSLMODE=require pg_dump -W --format=custom --no-owner \
    --host=YOUR_SUPABASE_DB_HOST --username=YOUR_DB_USERNAME \
    --dbname=postgres --file="$backup_file"
  chmod 600 "$backup_file"
  gpg --symmetric --cipher-algo AES256 "$backup_file"
  ```

  Database dumps do not contain Supabase Storage object bytes; back those up
  separately if private uploads are in use. Verify the encrypted export before
  removing any plaintext copy.

- Test restores into a separate staging Supabase project first. Review the
  target carefully before any destructive restore. Do not rerun the initial
  table-creation migration against the existing production database; verify
  RLS and policies after a restore. Restore only to a reviewed staging target;
  `--clean` removes existing objects in that target:

  ```bash
  gpg --output rishnova-staging.dump --decrypt rishnova-backup.dump.gpg
  PGSSLMODE=require pg_restore -W --clean --if-exists --no-owner \
    --host=YOUR_STAGING_SUPABASE_DB_HOST --username=YOUR_STAGING_DB_USERNAME \
    --dbname=postgres rishnova-staging.dump
  ```
- Keep encrypted backups of `/etc/rishnova.env`, the named tunnel's
  credentials JSON, and the tunnel UUID/config outside the VM. Restrict access
  to those backups; the environment file and tunnel credentials are sensitive.
- The model is reproducible and is not part of application backups. On a
  replacement VM, reinstall Ollama and run `ollama pull qwen3.5:0.8b` rather
  than copying weights into Git.
- For VM recovery, create a replacement Ubuntu ARM64 instance, repeat this
  guide, deploy the reviewed application checkout, restore the protected
  environment and tunnel config, then check all three services and the Pages
  proxy. Keep the same tunnel UUID/DNS route only if the Cloudflare credentials
  and ownership are intentionally being transferred.

Cloud resources, SMTP, Supabase settings, DNS, VM sizing, and credentials must
be configured and verified by an administrator. This document does not claim
that any cloud deployment has already happened.
