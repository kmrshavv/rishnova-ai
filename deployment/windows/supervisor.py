import ctypes
import hmac
import json
import logging
import logging.handlers
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
MODEL = "qwen3.5:0.8b"
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000
OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_KEEP_ALIVE = -1
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "RishNovaAI"
LOG_DIR = ROOT / "logs"
CONTROL_FILE = STATE_DIR / "control.json"
STATUS_FILE = STATE_DIR / "status.json"
LOCK_FILE = STATE_DIR / "supervisor.lock"
QUICK_TUNNEL_FILE = STATE_DIR / "quick-tunnel.json"
BACKEND_PYTHON = ROOT / "backend" / "venv" / "Scripts" / "python.exe"
PAGES_ORIGIN = "https://rishnova-ai.pages.dev"
CONTROL_HOST = "127.0.0.1"
CONTROL_PORT = 47831
HEALTH_INTERVAL_SECONDS = 20
LOG = logging.getLogger("rishnova.supervisor")
QUICK_TUNNEL_URL_PATTERN = re.compile(
    r"https://[a-z0-9-]+\.trycloudflare\.com",
    re.IGNORECASE,
)


def configure_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        LOG_DIR / "startup.log",
        maxBytes=2_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def read_control_info() -> dict[str, Any] | None:
    try:
        value = json.loads(CONTROL_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("token"), str):
        return None
    return value


def fetch_json(url: str, timeout: float = 5) -> tuple[int, dict[str, Any] | None]:
    request = urllib.request.Request(url, headers={"Cache-Control": "no-store"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
            return response.status, data if isinstance(data, dict) else None
    except urllib.error.HTTPError as error:
        try:
            data = json.loads(error.read().decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            data = None
        return error.code, data if isinstance(data, dict) else None
    except (OSError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError):
        return 0, None


def parse_tunnel_config(path: Path) -> tuple[str, str] | None:
    try:
        content = path.read_text(encoding="utf-8-sig")
    except OSError:
        return None

    tunnel_match = re.search(r"(?m)^tunnel:\s*['\"]?([0-9a-fA-F-]{36})['\"]?\s*$", content)
    credentials_match = re.search(r"(?m)^credentials-file:\s*(['\"])(.*?)\1\s*$", content)
    hostnames = re.findall(r"(?m)^\s*-\s*hostname:\s*['\"]?([A-Za-z0-9.-]+)['\"]?\s*$", content)
    services = re.findall(r"(?m)^\s*service:\s*['\"]?(https?://[^'\"\s]+)", content)
    catch_all = re.search(r"(?m)^\s*-\s*service:\s*http_status:404\s*$", content)
    if not (
        tunnel_match
        and credentials_match
        and len(hostnames) == 1
        and len(services) == 1
        and catch_all
    ):
        return None

    try:
        uuid.UUID(tunnel_match.group(1))
    except ValueError:
        return None

    hostname = hostnames[0].lower().rstrip(".")
    if (
        hostname in {"localhost", "127.0.0.1"}
        or hostname.endswith(".pages.dev")
        or hostname.endswith(".trycloudflare.com")
        or "." not in hostname
        or services[0].rstrip("/") != f"http://{BACKEND_HOST}:{BACKEND_PORT}"
    ):
        return None

    credentials = Path(credentials_match.group(2))
    if not credentials.is_file():
        return None
    return tunnel_match.group(1), hostname


def parse_quick_tunnel_url(path: Path, start_offset: int = 0) -> str | None:
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as log_file:
            log_file.seek(start_offset)
            content = log_file.read()[-65536:]
    except OSError:
        return None
    urls = QUICK_TUNNEL_URL_PATTERN.findall(content)
    return urls[-1].rstrip("/") if urls else None


def read_quick_tunnel_url(path: Path) -> str | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    url = value.get("url")
    if not isinstance(url, str) or not re.fullmatch(
        r"https://[a-z0-9-]+\.trycloudflare\.com",
        url,
        re.IGNORECASE,
    ):
        return None
    return url


def find_executable(name: str, candidates: tuple[Path, ...]) -> Path | None:
    located = shutil.which(name)
    if located:
        return Path(located)
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def powershell_service_info() -> list[dict[str, str]] | None:
    script = (
        "$services = @(Get-CimInstance Win32_Service | "
        "Where-Object { $_.Name -match 'ollama' -or $_.DisplayName -match 'ollama' } | "
        "Select-Object Name,State,StartMode); "
        "ConvertTo-Json -InputObject $services -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if result.returncode or not result.stdout.strip():
            return None
        parsed = json.loads(result.stdout)
        if isinstance(parsed, dict):
            return [parsed]
        return parsed if isinstance(parsed, list) else []
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def listener_addresses(port: int) -> list[str] | None:
    script = (
        f"$addresses = @(Get-NetTCPConnection -State Listen -LocalPort {port} "
        "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress); "
        "ConvertTo-Json -InputObject $addresses -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if result.returncode or not result.stdout.strip():
            return None
        parsed = json.loads(result.stdout)
        if isinstance(parsed, str):
            return [parsed]
        if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
            return parsed
        return None
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def ollama_process_exists() -> bool | None:
    try:
        result = subprocess.run(
            ["tasklist.exe", "/FI", "IMAGENAME eq ollama.exe", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode:
            return None
        return "ollama.exe" in result.stdout.lower()
    except (OSError, subprocess.SubprocessError):
        return None


class ControlHandler(BaseHTTPRequestHandler):
    server: "ControlServer"

    def _authorized(self) -> bool:
        info = read_control_info()
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {info['token']}" if info else ""
        return bool(expected) and hmac.compare_digest(supplied, expected)

    def _respond(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/status":
            self._respond(404, {"error": "Not found."})
        elif not self._authorized():
            self._respond(401, {"error": "Unauthorized."})
        else:
            self._respond(200, self.server.supervisor.status_snapshot())

    def do_POST(self) -> None:
        if self.path not in {"/start", "/stop"}:
            self._respond(404, {"error": "Not found."})
        elif not self._authorized():
            self._respond(401, {"error": "Unauthorized."})
        else:
            if self.path == "/stop":
                self._respond(202, {"status": "stopping"})
                self.server.supervisor.request_stop()
            else:
                self.server.supervisor.wake_event.set()
                self._respond(202, {"status": "starting"})

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class ControlServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Supervisor:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.state_lock = threading.Lock()
        self.processes: dict[str, subprocess.Popen[bytes]] = {}
        self.log_handles: dict[str, Any] = {}
        self.ollama_executable = find_executable(
            "ollama.exe",
            (
                Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe",
                Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Ollama" / "ollama.exe",
            ),
        )
        self.cloudflared_executable = find_executable(
            "cloudflared.exe",
            (
                Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
                / "cloudflared"
                / "cloudflared.exe",
                Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
                / "cloudflared"
                / "cloudflared.exe",
            ),
        )
        self.status: dict[str, Any] = {
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "updated_at": "",
            "internet": "checking",
            "ollama": "waiting",
            "model": "waiting",
            "backend": "waiting",
            "tunnel": "not_configured",
            "public_api": "not_configured",
            "public_api_url": "",
            "last_startup_error": "",
            "managed_processes": {},
        }
        self.control_server: ControlServer | None = None
        self.control_token = ""
        self.ollama_warmed = False
        self.quick_tunnel_log_offset = 0
        self.failure_streak = 0
        self.notified = False

    def status_snapshot(self) -> dict[str, Any]:
        with self.state_lock:
            return dict(self.status)

    def request_stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()

    def update(self, **changes: Any) -> None:
        with self.state_lock:
            self.status.update(changes)
            self.status["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            snapshot = dict(self.status)
        write_json(STATUS_FILE, snapshot)

    def record_error(self, message: str) -> None:
        previous = self.status_snapshot().get("last_startup_error", "")
        self.failure_streak += 1
        self.update(last_startup_error=message)
        if self.failure_streak >= 3 and not self.notified:
            self.notify_user(message)
            self.notified = True
        if message != previous:
            LOG.error("%s", message)

    def notify_user(self, message: str) -> None:
        try:
            subprocess.Popen(
                [
                    "msg.exe",
                    "*",
                    "/TIME:30",
                    f"RishNova server startup issue: {message}",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError:
            LOG.warning("Could not display a Windows session notification.")

    def start_control_server(self) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.control_token = uuid.uuid4().hex + uuid.uuid4().hex
        write_json(
            CONTROL_FILE,
            {"host": CONTROL_HOST, "port": CONTROL_PORT, "token": self.control_token},
        )
        self.control_server = ControlServer((CONTROL_HOST, CONTROL_PORT), ControlHandler)
        self.control_server.supervisor = self
        thread = threading.Thread(target=self.control_server.serve_forever, daemon=True)
        thread.start()

    def check_internet(self) -> bool:
        try:
            request = urllib.request.Request("https://www.cloudflare.com/cdn-cgi/trace")
            with urllib.request.urlopen(request, timeout=8) as response:
                return response.status == 200
        except (OSError, TimeoutError, urllib.error.URLError):
            return False

    def ollama_tags(self) -> set[str] | None:
        status, payload = fetch_json(f"{OLLAMA_URL}/api/tags", timeout=5)
        if status != 200 or not payload:
            return None
        models = payload.get("models", [])
        if not isinstance(models, list):
            return set()
        return {
            str(model.get("name") or model.get("model"))
            for model in models
            if isinstance(model, dict)
        }

    def start_ollama_service(self) -> bool | None:
        services = powershell_service_info()
        if services is None:
            self.record_error("Could not verify whether an Ollama Windows service is installed.")
            return None
        if services:
            for service in services:
                if str(service.get("State", "")).lower() != "running":
                    name = str(service.get("Name", ""))
                    script = (
                        f"Start-Service -Name '{name.replace(chr(39), chr(39) * 2)}' "
                        "-ErrorAction Stop"
                    )
                    try:
                        result = subprocess.run(
                            [
                                "powershell.exe",
                                "-NoProfile",
                                "-NonInteractive",
                                "-Command",
                                script,
                            ],
                            capture_output=True,
                            text=True,
                            timeout=15,
                            check=False,
                        )
                        if result.returncode:
                            LOG.warning("Could not start the existing Ollama service.")
                    except (OSError, subprocess.SubprocessError):
                        LOG.warning("Could not query the existing Ollama service.")
            return False

        existing_process = ollama_process_exists()
        if existing_process is None:
            self.record_error("Could not verify whether an Ollama process is already running.")
            return None
        if existing_process:
            return False
        if not self.ollama_executable:
            self.record_error("Ollama is unavailable and ollama.exe was not found.")
            return False

        environment = os.environ.copy()
        environment.update(
            {
                "OLLAMA_HOST": "127.0.0.1:11434",
                "OLLAMA_MAX_LOADED_MODELS": "1",
                "OLLAMA_NUM_PARALLEL": "1",
            }
        )
        self.start_child(
            "ollama",
            [str(self.ollama_executable), "serve"],
            LOG_DIR / "startup.log",
            environment,
            ROOT,
        )
        return True

    def start_child(
        self,
        name: str,
        command: list[str],
        log_path: Path,
        environment: dict[str, str] | None = None,
        working_directory: Path = ROOT,
    ) -> subprocess.Popen[bytes]:
        existing = self.processes.get(name)
        if existing and existing.poll() is None:
            return existing
        if existing:
            self.close_child(name)

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_handle = log_path.open("ab", buffering=0)
        startup_info = None
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if os.name == "nt":
            startup_info = subprocess.STARTUPINFO()
            startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup_info.wShowWindow = 0
        try:
            process = subprocess.Popen(
                command,
                cwd=str(working_directory),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                creationflags=creation_flags,
                startupinfo=startup_info,
            )
        except OSError:
            log_handle.close()
            raise
        self.processes[name] = process
        self.log_handles[name] = log_handle
        with self.state_lock:
            managed = dict(self.status["managed_processes"])
            managed[name] = process.pid
        self.update(managed_processes=managed)
        LOG.info("Started %s process (PID %s).", name, process.pid)
        return process

    def close_child(self, name: str) -> None:
        handle = self.log_handles.pop(name, None)
        if handle:
            handle.close()
        self.processes.pop(name, None)
        with self.state_lock:
            managed = dict(self.status["managed_processes"])
            managed.pop(name, None)
        self.update(managed_processes=managed)

    def wait_for_ollama(self, timeout: int = 90) -> set[str] | None:
        deadline = time.monotonic() + timeout
        while not self.stop_event.is_set() and time.monotonic() < deadline:
            tags = self.ollama_tags()
            if tags is not None:
                return tags
            self.stop_event.wait(2)
        return None

    def ensure_ollama(self, internet: bool) -> bool:
        managed_ollama = self.processes.get("ollama")
        if managed_ollama and managed_ollama.poll() is not None:
            LOG.warning("Ollama exited with code %s; it will be restarted.", managed_ollama.returncode)
            self.close_child("ollama")
            self.ollama_warmed = False
        tags = self.ollama_tags()
        if tags is None:
            started = self.start_ollama_service()
            if started is None:
                self.update(ollama="unknown", model="unknown")
                return False
            tags = self.wait_for_ollama(90 if started else 45)
        if tags is None:
            self.update(ollama="offline", model="unknown")
            self.record_error("Ollama did not become available at 127.0.0.1:11434.")
            return False
        addresses = listener_addresses(11434)
        if addresses is None or not addresses or any(
            address not in {"127.0.0.1", "::1"} for address in addresses
        ):
            self.update(ollama="unsafe_listener", model="unknown")
            self.record_error("Ollama must listen only on a loopback address at port 11434.")
            return False
        self.update(ollama="online")

        if MODEL not in tags:
            if not internet:
                self.update(model="missing")
                self.record_error(f"{MODEL} is missing; model download is waiting for internet access.")
                return False
            if not self.ollama_executable:
                self.update(model="missing")
                self.record_error("The configured Ollama model is missing and ollama.exe was not found.")
                return False
            LOG.info("Model %s is missing; downloading it once.", MODEL)
            self.update(model="downloading")
            try:
                environment = os.environ.copy()
                environment.update(
                    {
                        "OLLAMA_HOST": "127.0.0.1:11434",
                        "OLLAMA_MAX_LOADED_MODELS": "1",
                        "OLLAMA_NUM_PARALLEL": "1",
                    }
                )
                with (LOG_DIR / "startup.log").open("ab", buffering=0) as output:
                    pull = subprocess.Popen(
                        [str(self.ollama_executable), "pull", MODEL],
                        cwd=str(ROOT),
                        env=environment,
                        stdin=subprocess.DEVNULL,
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                    while pull.poll() is None and not self.stop_event.wait(2):
                        pass
                    if pull.poll() is None:
                        pull.terminate()
                        pull.wait(timeout=10)
                        return False
                    if pull.returncode:
                        self.update(model="missing")
                        self.record_error(f"Downloading {MODEL} failed; it will be retried later.")
                        return False
            except (OSError, subprocess.SubprocessError):
                self.update(model="missing")
                self.record_error(f"Downloading {MODEL} failed; check the startup log.")
                return False
            tags = self.ollama_tags()
            if tags is None or MODEL not in tags:
                self.update(model="missing")
                self.record_error(f"{MODEL} download completed but the model is not listed by Ollama.")
                return False

        self.update(model="available")
        if not self.ollama_warmed:
            payload = json.dumps(
                {
                    "model": MODEL,
                    "prompt": "Reply with OK.",
                    "stream": False,
                    "think": False,
                    "keep_alive": OLLAMA_KEEP_ALIVE,
                    "options": {"num_predict": 1},
                }
            ).encode("utf-8")
            request = urllib.request.Request(
                f"{OLLAMA_URL}/api/generate",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    if response.status != 200:
                        raise OSError("Ollama warm-up request failed.")
                    response.read()
                self.ollama_warmed = True
                LOG.info("Warmed %s and kept the single model loaded until shutdown.", MODEL)
            except (OSError, TimeoutError, urllib.error.URLError):
                self.update(model="warming")
                self.record_error(f"Could not warm {MODEL}; the startup sequence will retry.")
                return False
        return True

    def backend_ready(self) -> bool:
        status, payload = fetch_json(f"http://{BACKEND_HOST}:{BACKEND_PORT}/health/ready")
        return bool(status == 200 and payload and payload.get("status") == "ready")

    def ensure_backend(self) -> bool:
        if self.backend_ready():
            addresses = listener_addresses(BACKEND_PORT)
            if addresses is None or not addresses or any(
                address not in {"127.0.0.1", "::1"} for address in addresses
            ):
                self.update(backend="unsafe_listener")
                self.record_error("FastAPI must listen only on a loopback address at port 8000.")
                return False
            self.update(backend="online")
            return True

        existing = self.processes.get("backend")
        if existing and existing.poll() is not None:
            LOG.warning("FastAPI exited with code %s; it will be restarted.", existing.returncode)
            self.close_child("backend")

        if not self.processes.get("backend"):
            try:
                socket.create_connection((BACKEND_HOST, BACKEND_PORT), timeout=1).close()
            except OSError:
                pass
            else:
                self.update(backend="port_conflict")
                self.record_error(
                    "Port 8000 is occupied by a backend that did not pass readiness checks; refusing to start a duplicate."
                )
                return False

            if not BACKEND_PYTHON.is_file():
                self.update(backend="missing_runtime")
                self.record_error("The configured backend virtual-environment Python was not found.")
                return False

            environment = os.environ.copy()
            environment.update(
                {
                    "PYTHONUNBUFFERED": "1",
                    "RISHNOVA_PUBLIC_DEPLOYMENT": "1",
                    "OLLAMA_URL": OLLAMA_URL,
                    "OLLAMA_MODEL": MODEL,
                    "RISHNOVA_ALLOWED_MODELS": MODEL,
                    "CORS_ALLOWED_ORIGINS": PAGES_ORIGIN,
                    "FRONTEND_URL": PAGES_ORIGIN,
                }
            )
            try:
                self.start_child(
                    "backend",
                    [
                        str(BACKEND_PYTHON),
                        "-m",
                        "uvicorn",
                        "backend.main:app",
                        "--host",
                        BACKEND_HOST,
                        "--port",
                        str(BACKEND_PORT),
                        "--workers",
                        "1",
                        "--timeout-graceful-shutdown",
                        "30",
                        "--no-access-log",
                    ],
                    LOG_DIR / "backend.log",
                    environment,
                    ROOT,
                )
            except OSError:
                self.update(backend="failed")
                self.record_error("FastAPI could not be started; inspect logs/backend.log.")
                return False

        deadline = time.monotonic() + 60
        while not self.stop_event.is_set() and time.monotonic() < deadline:
            process = self.processes.get("backend")
            if process and process.poll() is not None:
                self.close_child("backend")
                break
            if self.backend_ready():
                self.update(backend="online")
                LOG.info("FastAPI readiness check passed.")
                return True
            self.stop_event.wait(3)
        self.update(backend="starting")
        self.record_error("FastAPI did not pass its readiness check; startup will retry.")
        return False

    def ensure_tunnel(self) -> bool:
        config_path = STATE_DIR / "cloudflared.yml"
        tunnel = parse_tunnel_config(config_path)
        if not tunnel:
            return self.ensure_quick_tunnel()
        tunnel_id, hostname = tunnel
        process = self.processes.get("tunnel")
        if process and process.poll() is not None:
            LOG.warning("Cloudflare Tunnel exited with code %s; it will be restarted.", process.returncode)
            self.close_child("tunnel")
        if not self.cloudflared_executable:
            self.update(tunnel="missing_runtime")
            self.record_error("cloudflared.exe was not found.")
            return False
        if not self.processes.get("tunnel"):
            try:
                self.start_child(
                    "tunnel",
                    [
                        str(self.cloudflared_executable),
                        "tunnel",
                        "--config",
                        str(config_path),
                        "run",
                        tunnel_id,
                    ],
                    LOG_DIR / "tunnel.log",
                    os.environ.copy(),
                    ROOT,
                )
            except OSError:
                self.update(tunnel="failed")
                self.record_error("Cloudflare Tunnel could not be started; inspect logs/tunnel.log.")
                return False

        self.update(tunnel="connecting")
        status, payload = fetch_json(f"https://{hostname}/api/health", timeout=8)
        if status == 200 and payload and payload.get("status") == "online":
            self.update(
                tunnel="online",
                public_api="online",
                public_api_url=f"https://{hostname}",
            )
            return True
        self.update(tunnel="connecting", public_api="offline")
        return False

    def quick_tunnel_process_exists(self) -> bool | None:
        script = (
            "$processes = @(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | "
            "Select-Object ProcessId,CommandLine); "
            "ConvertTo-Json -InputObject $processes -Compress"
        )
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            if result.returncode or not result.stdout.strip():
                return None
            parsed = json.loads(result.stdout)
            processes = [parsed] if isinstance(parsed, dict) else parsed
            if not isinstance(processes, list):
                return None
            return any(
                isinstance(item, dict)
                and isinstance(item.get("CommandLine"), str)
                and "--url" in item["CommandLine"]
                and "127.0.0.1:8000" in item["CommandLine"]
                for item in processes
            )
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            return None

    def ensure_quick_tunnel(self) -> bool:
        process = self.processes.get("tunnel")
        if process and process.poll() is not None:
            LOG.warning(
                "Cloudflare Quick Tunnel exited with code %s; it will be restarted.",
                process.returncode,
            )
            self.close_child("tunnel")
            try:
                QUICK_TUNNEL_FILE.unlink(missing_ok=True)
            except OSError:
                LOG.warning("Could not remove the stale Quick Tunnel URL configuration.")
            process = None

        if not self.cloudflared_executable:
            self.update(tunnel="missing_runtime", public_api="offline", public_api_url="")
            self.record_error("cloudflared.exe was not found.")
            return False

        url = read_quick_tunnel_url(QUICK_TUNNEL_FILE) if process else None
        if process is None:
            existing_quick_tunnel = self.quick_tunnel_process_exists()
            if existing_quick_tunnel is None:
                self.update(tunnel="unknown", public_api="offline")
                self.record_error("Could not check for an existing Cloudflare Quick Tunnel process.")
                return False
            if existing_quick_tunnel:
                self.update(tunnel="process_conflict", public_api="offline")
                self.record_error(
                    "An unmanaged Quick Tunnel already targets FastAPI; refusing to create a duplicate."
                )
                return False
            try:
                tunnel_log = LOG_DIR / "tunnel.log"
                self.quick_tunnel_log_offset = (
                    tunnel_log.stat().st_size if tunnel_log.exists() else 0
                )
                process = self.start_child(
                    "tunnel",
                    [
                        str(self.cloudflared_executable),
                        "tunnel",
                        "--url",
                        f"http://{BACKEND_HOST}:{BACKEND_PORT}",
                        "--no-autoupdate",
                    ],
                    tunnel_log,
                    os.environ.copy(),
                    ROOT,
                )
            except OSError:
                self.update(tunnel="failed", public_api="offline")
                self.record_error("Cloudflare Quick Tunnel could not be started; inspect logs/tunnel.log.")
                return False

        if not url:
            deadline = time.monotonic() + 45
            while not self.stop_event.is_set() and time.monotonic() < deadline:
                if process.poll() is not None:
                    self.close_child("tunnel")
                    self.update(tunnel="failed", public_api="offline")
                    self.record_error(
                        "Cloudflare Quick Tunnel exited before publishing its URL; inspect logs/tunnel.log."
                    )
                    return False
                url = parse_quick_tunnel_url(
                    LOG_DIR / "tunnel.log",
                    self.quick_tunnel_log_offset,
                )
                if url:
                    write_json(
                        QUICK_TUNNEL_FILE,
                        {"url": url, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                    )
                    LOG.info("Cloudflare Quick Tunnel published %s.", url)
                    break
                self.stop_event.wait(1)

        if not url:
            self.update(tunnel="connecting", public_api="offline")
            self.record_error("Cloudflare Quick Tunnel did not publish a URL within 45 seconds.")
            return False

        self.update(tunnel="connecting", public_api="offline", public_api_url=url)
        status, payload = fetch_json(f"{url}/health/ready", timeout=15)
        if status == 200 and payload and payload.get("status") == "ready":
            self.update(tunnel="online", public_api="online", public_api_url=url)
            return True
        self.update(tunnel="connecting", public_api="offline", public_api_url=url)
        return False

    def check_console_events(self) -> None:
        if os.name != "nt":
            return
        handler_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_uint)

        def handler(event: int) -> bool:
            if event in {0, 1, 2, 5, 6}:
                self.request_stop()
                return True
            return False

        self.console_handler = handler_type(handler)
        if not ctypes.windll.kernel32.SetConsoleCtrlHandler(self.console_handler, True):
            LOG.warning("Windows console shutdown notifications could not be registered.")

    def stop_child(self, name: str, grace_seconds: int) -> None:
        process = self.processes.get(name)
        if process is None:
            return
        if process.poll() is None:
            LOG.info("Requesting graceful stop for %s (PID %s).", name, process.pid)
            try:
                if os.name == "nt" and hasattr(signal, "CTRL_BREAK_EVENT"):
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.terminate()
                process.wait(timeout=grace_seconds)
            except (OSError, subprocess.TimeoutExpired):
                LOG.warning("%s did not exit gracefully; terminating its managed process.", name)
                try:
                    process.terminate()
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    LOG.error("%s did not stop after the graceful timeout.", name)
                    process.kill()
                    process.wait(timeout=5)
        self.close_child(name)

    def stop_all(self) -> None:
        self.stop_child("tunnel", 15)
        try:
            QUICK_TUNNEL_FILE.unlink(missing_ok=True)
        except OSError:
            LOG.warning("Could not remove the stopped Quick Tunnel URL configuration.")
        self.stop_child("backend", 35)
        self.stop_child("ollama", 20)
        self.update(
            ollama="stopped",
            model="stopped",
            backend="stopped",
            tunnel="stopped",
            public_api="offline",
            public_api_url="",
            last_startup_error="",
        )

    def run(self) -> int:
        if os.name != "nt":
            raise RuntimeError("The Windows server supervisor must run on Windows.")
        if not BACKEND_PYTHON.is_file():
            raise RuntimeError(f"Backend Python was not found at {BACKEND_PYTHON}.")
        configure_logging()
        LOG.info("Starting the RishNova Windows server supervisor.")
        self.start_control_server()
        self.check_console_events()
        signal.signal(signal.SIGINT, lambda _signal, _frame: self.request_stop())
        signal.signal(signal.SIGTERM, lambda _signal, _frame: self.request_stop())
        if hasattr(signal, "SIGBREAK"):
            signal.signal(signal.SIGBREAK, lambda _signal, _frame: self.request_stop())

        delay = 15
        last_health_log = 0.0
        try:
            while not self.stop_event.is_set():
                internet = self.check_internet()
                self.update(internet="online" if internet else "offline")
                if not internet:
                    self.record_error("Internet is unavailable; startup and the public Tunnel will retry.")
                ollama_ready = self.ensure_ollama(internet)
                if ollama_ready:
                    backend_ready = self.ensure_backend()
                    if backend_ready:
                        tunnel_ready = self.ensure_tunnel()
                        if tunnel_ready:
                            self.failure_streak = 0
                            self.notified = False
                            self.update(last_startup_error="")
                            delay = 20
                        else:
                            delay = min(max(delay, 20) * 2, 300)
                    else:
                        delay = min(max(delay, 15) * 2, 300)
                else:
                    delay = min(max(delay, 15) * 2, 300)

                now = time.monotonic()
                if now - last_health_log >= HEALTH_INTERVAL_SECONDS:
                    with (LOG_DIR / "health.log").open("a", encoding="utf-8") as health_log:
                        health_log.write(json.dumps(self.status_snapshot(), sort_keys=True) + "\n")
                    last_health_log = now
                self.wake_event.wait(delay)
                if self.wake_event.is_set():
                    self.wake_event.clear()
                    delay = 1
        except Exception as error:
            LOG.exception("The server supervisor encountered an unexpected error.")
            self.update(last_startup_error=f"Supervisor error: {type(error).__name__}.")
            return 1
        finally:
            self.stop_all()
            if self.control_server:
                self.control_server.shutdown()
                self.control_server.server_close()
            for path in (CONTROL_FILE, STATUS_FILE.with_suffix(".tmp")):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    LOG.warning("Could not remove temporary supervisor state.")
            if os.name == "nt" and hasattr(self, "console_handler"):
                ctypes.windll.kernel32.SetConsoleCtrlHandler(self.console_handler, False)
            LOG.info("RishNova server supervisor stopped.")
        return 0


def acquire_singleton() -> Any:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    handle = LOCK_FILE.open("a+b")
    try:
        import msvcrt

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except (ImportError, OSError):
        handle.close()
        return None
    return handle


def main() -> int:
    lock_handle = acquire_singleton()
    if lock_handle is None:
        return 0
    try:
        return Supervisor().run()
    finally:
        lock_handle.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        try:
            configure_logging()
            LOG.exception("Supervisor could not start: %s", type(error).__name__)
        except OSError:
            print(f"Supervisor could not start: {type(error).__name__}", file=sys.stderr)
        raise
