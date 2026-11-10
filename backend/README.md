# FastAPI backend

The backend setup, Windows 11 startup commands, Supabase configuration,
Cloudflare Quick Tunnel instructions, API protections, limitations, and security
checklist are documented in the project [README](../README.md).

Run FastAPI from the project root and bind to loopback only:

```powershell
backend\venv\Scripts\python.exe -m pip install -r backend\requirements.txt
backend\venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

The backend loads root `.env` when present. Its only elevated setting is
administrator email allowlisting; database calls use each user's Supabase JWT
and the public anon/publishable key. Never configure a service-role key.
