# FastAPI backend

The Oracle Cloud Ubuntu ARM64 deployment, systemd services, named Cloudflare
Tunnel, Pages proxy configuration, and recovery procedure are documented in
[CLOUD_DEPLOYMENT.md](../CLOUD_DEPLOYMENT.md). Local Windows development and
the Supabase/authentication overview are documented in the project
[README](../README.md).

Run FastAPI from the project root and bind to loopback only:

```powershell
backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
backend\venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

`GET /health` is a liveness check; `GET /health/ready` checks that the
configured Ollama model is available without disclosing internal details.
`GET /api/health` remains the frontend-compatible availability endpoint.

The backend loads root `.env` when present. Ollama must use a loopback
`OLLAMA_URL`; the configured model defaults to `qwen3.5:0.8b`. Database calls
use each user's verified Supabase JWT and the public
`SUPABASE_PUBLISHABLE_KEY`. Never configure a service-role key.
