import asyncio
import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from ollama import AsyncClient, ResponseError
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("rishnova.api")


def load_local_env() -> None:
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        value = value.strip().strip("\"'")
        os.environ.setdefault(key.strip(), value)


load_local_env()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", os.getenv("SUPABASE_ANON_KEY", ""))
SUPABASE_JWKS_URL = os.getenv(
    "SUPABASE_JWKS_URL",
    f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else "",
)
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
if urlparse(OLLAMA_HOST).hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise RuntimeError("OLLAMA_HOST must point to a loopback address. Do not expose Ollama publicly.")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "qwen3.5:0.8b")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://127.0.0.1:5500").rstrip("/")
MAX_REQUEST_BYTES = 48 * 1024
MAX_MESSAGES = 24
MAX_TOTAL_CHARS = 16_000
MESSAGE_CONTENT = Annotated[str, StringConstraints(min_length=1, max_length=4_000)]
SUPPORTED_MODELS = {
    "qwen3.5:0.8b": "Qwen 3.5 0.8B",
    "qwen3.5:2b-q4_K_M": "Qwen 3.5 2B Q4",
}


def configured_models() -> tuple[str, ...]:
    configured = os.getenv("RISHNOVA_ALLOWED_MODELS", DEFAULT_MODEL)
    requested = tuple(dict.fromkeys(item.strip() for item in configured.split(",") if item.strip()))
    if not requested or set(requested).difference(SUPPORTED_MODELS):
        raise RuntimeError("RISHNOVA_ALLOWED_MODELS must contain only approved model names.")
    if DEFAULT_MODEL not in requested:
        raise RuntimeError("DEFAULT_MODEL must be included in RISHNOVA_ALLOWED_MODELS.")
    return requested


def bounded_environment_int(name: str, default: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer.") from error
    if not 1 <= value <= maximum:
        raise RuntimeError(f"{name} must be between 1 and {maximum}.")
    return value


ALLOWED_MODELS = configured_models()
DEFAULT_USER_RPM = bounded_environment_int("RISHNOVA_USER_RPM", 6, 20)
DEFAULT_DAILY_LIMIT = bounded_environment_int("RISHNOVA_DAILY_LIMIT", 40, 500)
ALLOWED_ORIGINS = tuple(
    origin.strip()
    for origin in os.getenv("RISHNOVA_CORS_ORIGINS", FRONTEND_URL).split(",")
    if origin.strip()
)
ADMIN_EMAILS = {
    email.strip().lower()
    for email in os.getenv("RISHNOVA_ADMIN_EMAILS", "").split(",")
    if email.strip()
}


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: MESSAGE_CONTENT


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: UUID
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)
    model: str = DEFAULT_MODEL

    @model_validator(mode="after")
    def validate_history_size(self) -> "ChatRequest":
        if sum(len(message.content) for message in self.messages) > MAX_TOTAL_CHARS:
            raise ValueError(f"Combined message content must not exceed {MAX_TOTAL_CHARS} characters.")
        if self.messages[-1].role != "user":
            raise ValueError("The last message must be from the user.")
        return self


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    title: Annotated[str, StringConstraints(min_length=1, max_length=80)] = "New conversation"
    model: str = DEFAULT_MODEL
    pinned: bool = False
    project: Annotated[str, StringConstraints(max_length=40)] | None = None


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Annotated[str, StringConstraints(min_length=1, max_length=80)] | None = None
    pinned: bool | None = None
    project: Annotated[str, StringConstraints(max_length=40)] | None = None


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    full_name: Annotated[str, StringConstraints(max_length=100)] = ""
    avatar_url: Annotated[str, StringConstraints(max_length=2_000)] = ""


class UsageLimitsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requests_per_minute: int = Field(ge=1, le=20)
    daily_limit: int = Field(ge=1, le=500)


def require_configuration() -> None:
    if not SUPABASE_URL or not SUPABASE_ANON_KEY or not SUPABASE_JWKS_URL:
        raise HTTPException(status_code=503, detail="Backend authentication is not configured.")


def decode_token(token: str, signing_key: jwt.PyJWK) -> dict:
    issuer = f"{SUPABASE_URL}/auth/v1"
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=[signing_key.algorithm_name],
        audience="authenticated",
        issuer=issuer,
        options={"require": ["exp", "iat", "sub", "iss", "aud"]},
    )


async def verify_legacy_token_with_supabase(token: str) -> dict:
    if not SUPABASE_ANON_KEY:
        raise HTTPException(status_code=503, detail="Backend authentication is not configured.")
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": f"Bearer {token}",
                },
            )
    except httpx.HTTPError as error:
        logger.warning("Supabase legacy token verification failed: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="Authentication verification is temporarily unavailable.")
    if response.status_code in {401, 403}:
        raise HTTPException(status_code=401, detail="Your session is invalid or expired. Please sign in again.")
    if response.status_code >= 400:
        logger.warning("Supabase Auth returned HTTP %s during token verification.", response.status_code)
        raise HTTPException(status_code=503, detail="Authentication verification is temporarily unavailable.")
    try:
        auth_user = response.json()
        if not isinstance(auth_user, dict):
            raise ValueError("Supabase Auth returned an invalid user response.")
        user_id = str(UUID(auth_user["id"]))
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=401, detail="Your session is invalid or expired. Please sign in again.")
    return {"id": user_id, "email": str(auth_user.get("email", "")).lower(), "token": token}


async def verified_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    require_configuration()
    check_general_ip_limit(request)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Sign in to use this endpoint.")
    token = authorization[7:].strip()
    if not token or len(token) > 8_192:
        raise HTTPException(status_code=401, detail="The access token is invalid.")
    try:
        header = jwt.get_unverified_header(token)
        algorithm = header.get("alg")
        if algorithm == "HS256":
            return await verify_legacy_token_with_supabase(token)
        if algorithm not in {"ES256", "ES384", "RS256", "EdDSA"} or not header.get("kid"):
            raise jwt.InvalidTokenError("Unsupported JWT signing algorithm.")
        keys = await get_jwks(request)
        jwk = next((item for item in keys if item.get("kid") == header["kid"]), None)
        if jwk is None:
            request.app.state.jwks = []
            keys = await get_jwks(request, force=True)
            jwk = next((item for item in keys if item.get("kid") == header["kid"]), None)
        if jwk is None:
            raise jwt.InvalidTokenError("Signing key was not found.")
        signing_key = jwt.PyJWK.from_dict(jwk)
        if signing_key.algorithm_name != algorithm:
            raise jwt.InvalidTokenError("JWT algorithm does not match the signing key.")
        claims = decode_token(token, signing_key)
        UUID(claims["sub"])
        if claims.get("role") != "authenticated":
            raise jwt.InvalidTokenError("Token does not belong to an authenticated user.")
        return {"id": claims["sub"], "email": str(claims.get("email", "")).lower(), "token": token}
    except (jwt.PyJWTError, ValueError, KeyError, TypeError):
        raise HTTPException(status_code=401, detail="Your session is invalid or expired. Please sign in again.")


async def get_jwks(request: Request, force: bool = False) -> list[dict]:
    now = time.monotonic()
    cached = request.app.state.jwks
    if not force and cached and now < request.app.state.jwks_expires:
        return cached
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(SUPABASE_JWKS_URL)
            response.raise_for_status()
            keys = response.json().get("keys", [])
            if not isinstance(keys, list) or not keys:
                raise ValueError("JWKS response has no signing keys.")
    except (httpx.HTTPError, ValueError, TypeError) as error:
        logger.warning("Unable to retrieve Supabase signing keys: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="Authentication verification is temporarily unavailable.")
    request.app.state.jwks = keys
    request.app.state.jwks_expires = now + 300
    return keys


CurrentUser = Annotated[dict, Depends(verified_user)]


async def database_request(
    user: dict,
    method: str,
    table: str,
    *,
    params: dict | None = None,
    body: dict | list[dict] | None = None,
    prefer: str | None = None,
) -> list[dict] | dict | None:
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {user['token']}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.request(
                method,
                f"{SUPABASE_URL}/rest/v1/{table}",
                params=params,
                json=body,
                headers=headers,
            )
    except httpx.HTTPError as error:
        logger.warning("Supabase database request failed: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="The database is temporarily unavailable.")
    if response.status_code >= 400:
        logger.warning("Supabase database returned HTTP %s for %s.", response.status_code, table)
        if response.status_code in {401, 403}:
            raise HTTPException(status_code=403, detail="You are not allowed to access this data.")
        raise HTTPException(status_code=502, detail="The database could not complete the request.")
    if response.status_code == 204 or not response.content:
        return None
    data = response.json()
    return data


def validate_model(model: str) -> None:
    if model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail="The selected model is not approved.")


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("cf-connecting-ip", "").strip()
    if forwarded and request.client and request.client.host in {"127.0.0.1", "::1"}:
        return forwarded[:64]
    return request.client.host if request.client else "unknown"


def check_general_ip_limit(request: Request) -> None:
    now = time.monotonic()
    events = request.app.state.api_ip_events[client_ip(request)]
    while events and events[0] <= now - 60:
        events.popleft()
    if len(events) >= 90:
        raise HTTPException(status_code=429, detail="This network has sent too many requests. Please try again later.")
    events.append(now)


def check_rate_limit(request: Request, user: dict) -> int:
    now = time.monotonic()
    day = datetime.now(timezone.utc).date().isoformat()
    limits = request.app.state.limits
    user_key = user["id"]
    ip_key = client_ip(request)
    user_events = request.app.state.user_events[user_key]
    ip_events = request.app.state.ip_events[ip_key]
    while user_events and user_events[0][0] <= now - 60:
        user_events.popleft()
    while ip_events and ip_events[0] <= now - 60:
        ip_events.popleft()
    usage = request.app.state.daily_usage[user_key]
    if usage["day"] != day:
        usage.update(day=day, count=0)
    if len(user_events) >= limits["requests_per_minute"]:
        raise HTTPException(status_code=429, detail="Too many requests. Please wait a minute and try again.")
    if len(ip_events) >= 30:
        raise HTTPException(status_code=429, detail="This network has sent too many requests. Please try again later.")
    if usage["count"] >= limits["daily_limit"]:
        raise HTTPException(status_code=429, detail="Your daily chat limit has been reached. Please try again tomorrow.")
    user_events.append((now, day))
    ip_events.append(now)
    usage["count"] += 1
    return max(0, limits["daily_limit"] - usage["count"])


def is_admin(user: dict) -> bool:
    return bool(user["email"]) and user["email"] in ADMIN_EMAILS


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.ollama = AsyncClient(host=OLLAMA_HOST, timeout=180)
    app.state.inference_lock = asyncio.Semaphore(1)
    app.state.jwks = []
    app.state.jwks_expires = 0.0
    app.state.user_events = defaultdict(deque)
    app.state.ip_events = defaultdict(deque)
    app.state.api_ip_events = defaultdict(deque)
    app.state.health_events = defaultdict(deque)
    app.state.daily_usage = defaultdict(lambda: {"day": "", "count": 0})
    app.state.limits = {
        "requests_per_minute": DEFAULT_USER_RPM,
        "daily_limit": DEFAULT_DAILY_LIMIT,
    }
    try:
        yield
    finally:
        await app.state.ollama.close()


app = FastAPI(
    title="RishNova AI API",
    version="2.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "apikey"],
)


@app.middleware("http")
async def security_and_size_headers(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse(status_code=413, content={"detail": "Request body is too large."})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header."})
    if request.url.path == "/api/health" and request.method == "GET":
        events = request.app.state.health_events[client_ip(request)]
        now = time.monotonic()
        while events and events[0] <= now - 60:
            events.popleft()
        if len(events) >= 30:
            return JSONResponse(status_code=429, content={"detail": "Health checks are temporarily rate limited."})
        events.append(now)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    return response


@app.get("/api/health")
async def health(request: Request):
    try:
        installed = {item.model for item in (await request.app.state.ollama.list()).models}
        models = [name for name in ALLOWED_MODELS if name in installed]
        return {
            "status": "online",
            "ollama_available": True,
            "default_model": DEFAULT_MODEL,
            "available_models": models,
        }
    except Exception as error:
        logger.info("Ollama health check failed: %s", type(error).__name__)
        return {"status": "offline", "ollama_available": False, "default_model": DEFAULT_MODEL, "available_models": []}


@app.get("/api/models", dependencies=[Depends(verified_user)])
async def available_models(request: Request):
    try:
        installed = {item.model for item in (await request.app.state.ollama.list()).models}
    except Exception as error:
        logger.info("Ollama model listing failed: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="Ollama is unavailable. Start the local Ollama service and retry.")
    return {
        "models": [
            {"name": name, "display_name": SUPPORTED_MODELS[name]}
            for name in ALLOWED_MODELS
            if name in installed
        ],
        "default_model": DEFAULT_MODEL,
    }


@app.get("/api/profile")
async def get_profile(user: CurrentUser):
    profile = await database_request(
        user, "GET", "profiles", params={"id": f"eq.{user['id']}", "select": "id,email,full_name,avatar_url,created_at", "limit": "1"}
    )
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return {**profile[0], "is_admin": is_admin(user)}


@app.get("/api/usage")
async def get_usage(request: Request, user: CurrentUser):
    day = datetime.now(timezone.utc).date().isoformat()
    usage = request.app.state.daily_usage[user["id"]]
    if usage["day"] != day:
        usage.update(day=day, count=0)
    return {"daily_remaining": max(0, request.app.state.limits["daily_limit"] - usage["count"])}


@app.put("/api/profile")
async def update_profile(payload: ProfileUpdate, user: CurrentUser):
    rows = await database_request(
        user,
        "PATCH",
        "profiles",
        params={"id": f"eq.{user['id']}", "select": "id,email,full_name,avatar_url,created_at"},
        body={"full_name": payload.full_name.strip(), "avatar_url": payload.avatar_url.strip()},
        prefer="return=representation",
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return {**rows[0], "is_admin": is_admin(user)}


@app.get("/api/conversations")
async def list_conversations(user: CurrentUser):
    rows = await database_request(
        user,
        "GET",
        "conversations",
        params={"select": "id,user_id,title,model,pinned,project,created_at,updated_at", "order": "updated_at.desc"},
    )
    return {"conversations": rows or []}


@app.post("/api/conversations")
async def create_conversation(payload: ConversationCreate, user: CurrentUser):
    validate_model(payload.model)
    existing = await database_request(
        user,
        "GET",
        "conversations",
        params={
            "id": f"eq.{payload.id}",
            "user_id": f"eq.{user['id']}",
            "select": "id,user_id,title,model,pinned,project,created_at,updated_at",
            "limit": "1",
        },
    )
    if existing:
        return existing[0]
    rows = await database_request(
        user,
        "POST",
        "conversations",
        params={"select": "id,user_id,title,model,pinned,project,created_at,updated_at"},
        body={
            "id": str(payload.id),
            "user_id": user["id"],
            "title": payload.title.strip() or "New conversation",
            "model": payload.model,
            "pinned": payload.pinned,
            "project": payload.project,
        },
        prefer="return=representation",
    )
    return rows[0]


@app.put("/api/conversations/{conversation_id}")
async def update_conversation(conversation_id: UUID, payload: ConversationUpdate, user: CurrentUser):
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="No conversation changes were provided.")
    if "title" in changes:
        if changes["title"] is None or not changes["title"].strip():
            raise HTTPException(status_code=422, detail="A conversation title is required.")
        changes["title"] = changes["title"].strip()
    changes["updated_at"] = datetime.now(timezone.utc).isoformat()
    rows = await database_request(
        user,
        "PATCH",
        "conversations",
        params={
            "id": f"eq.{conversation_id}",
            "user_id": f"eq.{user['id']}",
            "select": "id,user_id,title,model,pinned,project,created_at,updated_at",
        },
        body=changes,
        prefer="return=representation",
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return rows[0]


@app.get("/api/conversations/{conversation_id}/messages")
async def get_messages(conversation_id: UUID, user: CurrentUser):
    rows = await database_request(
        user,
        "GET",
        "messages",
        params={
            "conversation_id": f"eq.{conversation_id}",
            "user_id": f"eq.{user['id']}",
            "select": "id,conversation_id,user_id,role,content,created_at",
            "order": "created_at.asc",
            "limit": "500",
        },
    )
    return {"messages": rows or []}


@app.delete("/api/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: UUID, user: CurrentUser):
    await database_request(
        user,
        "DELETE",
        "conversations",
        params={"id": f"eq.{conversation_id}", "user_id": f"eq.{user['id']}"},
    )
    return None


@app.post("/api/chat")
async def chat(payload: ChatRequest, request: Request, user: CurrentUser):
    validate_model(payload.model)
    remaining = check_rate_limit(request, user)
    try:
        conversations = await database_request(
            user,
            "GET",
            "conversations",
            params={
                "id": f"eq.{payload.conversation_id}",
                "user_id": f"eq.{user['id']}",
                "select": "id,title,model",
                "limit": "1",
            },
        )
        if not conversations:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        stored_messages = await database_request(
            user,
            "GET",
            "messages",
            params={
                "conversation_id": f"eq.{payload.conversation_id}",
                "user_id": f"eq.{user['id']}",
                "select": "role,content",
                "order": "created_at.desc",
                "limit": str(MAX_MESSAGES - 1),
            },
        )
        history = list(reversed(stored_messages or []))
        latest = payload.messages[-1]
        history.append({"role": latest.role, "content": latest.content})
        while len(history) > 1 and sum(len(item["content"]) for item in history) > MAX_TOTAL_CHARS:
            history.pop(0)
        await database_request(
            user,
            "POST",
            "messages",
            body={
                "conversation_id": str(payload.conversation_id),
                "user_id": user["id"],
                "role": "user",
                "content": latest.content,
            },
            prefer="return=minimal",
        )
    except HTTPException:
        raise

    try:
        installed = {item.model for item in (await request.app.state.ollama.list()).models}
    except Exception as error:
        logger.info("Ollama unavailable during chat: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="Ollama is unavailable. Start Ollama and try again.")
    if payload.model not in installed:
        raise HTTPException(status_code=404, detail=f"{payload.model} is not installed. Run `ollama pull {payload.model}`.")
    try:
        async with asyncio.timeout(5):
            await request.app.state.inference_lock.acquire()
    except TimeoutError:
        raise HTTPException(status_code=429, detail="The AI is busy. Please try again in a few seconds.")
    try:
        response = await request.app.state.ollama.chat(
            model=payload.model,
            messages=history,
            options={"num_ctx": 2048, "num_predict": 256, "num_batch": 64, "num_thread": 4, "temperature": 0.7},
            think=False,
            keep_alive=0,
        )
    except ResponseError as error:
        logger.warning("Ollama returned HTTP %s.", error.status_code)
        raise HTTPException(status_code=502, detail="Ollama could not complete the request.")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="The AI request timed out. Please try again.")
    except Exception as error:
        logger.warning("Ollama chat failed: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="Ollama could not complete the request.")
    finally:
        request.app.state.inference_lock.release()
    reply = response.message.content.strip()
    if not reply:
        raise HTTPException(status_code=502, detail="Ollama returned an empty response. Please try again.")
    await database_request(
        user,
        "POST",
        "messages",
        body={
            "conversation_id": str(payload.conversation_id),
            "user_id": user["id"],
            "role": "assistant",
            "content": reply,
        },
        prefer="return=minimal",
    )
    await database_request(
        user,
        "PATCH",
        "conversations",
        params={"id": f"eq.{payload.conversation_id}", "user_id": f"eq.{user['id']}"},
        body={"model": payload.model, "updated_at": datetime.now(timezone.utc).isoformat()},
        prefer="return=minimal",
    )
    return {"reply": reply, "model": payload.model, "usage": {"daily_remaining": remaining}}


@app.get("/api/admin/limits")
async def get_usage_limits(request: Request, user: CurrentUser):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Administrator access is required.")
    return dict(request.app.state.limits)


@app.put("/api/admin/limits")
async def update_usage_limits(payload: UsageLimitsUpdate, request: Request, user: CurrentUser):
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Administrator access is required.")
    request.app.state.limits = payload.model_dump()
    return dict(request.app.state.limits)


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, error: Exception):
    logger.error("Unhandled API error on %s: %s", request.url.path, type(error).__name__)
    return JSONResponse(status_code=500, content={"detail": "The server could not complete the request."})
