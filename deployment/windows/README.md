# Windows server scripts

The full prerequisites, named-tunnel setup, Pages configuration, startup
sequence, security model, limitations, and verification steps are in
[CLOUD_SERVER_SETUP.md](../../CLOUD_SERVER_SETUP.md).

Run the one-time installer from the repository root in PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deployment\windows\install.ps1
```

The installer registers one current-user logon task and starts its supervisor.
It does not elevate, configure a Quick Tunnel, expose a port, install another
Ollama instance, or change Cloudflare resources. Configure a stable named
tunnel only after confirming that you control a DNS domain in Cloudflare.

Operational scripts:

- `start-rishnova.ps1` asks the running supervisor to start/recover the stack.
- `stop-rishnova.ps1` requests graceful shutdown of supervisor-owned processes.
- `shutdown.ps1` is invoked by a marked Task Scheduler shutdown-event task;
  the supervisor also handles Windows logoff/shutdown console events.
- `health-check.ps1` reports internet, Ollama, model, FastAPI, tunnel, public
  API, and the last startup error.
- `configure-cloudflare.ps1 -ApiHostname api.example.com` creates/configures
  the named tunnel after validating the hostname.
- `uninstall.ps1` stops the managed stack and removes only its owned tasks;
  logs, local tunnel configuration, credentials, Ollama, and model files remain.
