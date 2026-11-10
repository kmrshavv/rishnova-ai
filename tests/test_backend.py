import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from backend import main


class BackendSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_supabase_url = main.SUPABASE_URL
        main.SUPABASE_URL = "https://test-project.supabase.co"
        cls.private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.user_id = str(uuid4())
        cls.jwk = jwt.algorithms.RSAAlgorithm.to_jwk(cls.private_key.public_key(), as_dict=True)
        cls.jwk.update({"kid": "test-key", "alg": "RS256", "use": "sig"})

    @classmethod
    def tearDownClass(cls):
        main.SUPABASE_URL = cls.original_supabase_url

    def setUp(self):
        self.client_context = TestClient(main.app)
        self.client = self.client_context.__enter__()
        self.configuration = patch("backend.main.require_configuration", return_value=None)
        self.configuration.start()

    def tearDown(self):
        self.configuration.stop()
        self.client_context.__exit__(None, None, None)

    def test_private_models_endpoint_requires_a_bearer_token(self):
        response = self.client.get("/api/models")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "Sign in to use this endpoint.")

    def test_malformed_bearer_token_is_rejected(self):
        response = self.client.get("/api/models", headers={"Authorization": "Bearer not-a-jwt"})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "Your session is invalid or expired. Please sign in again.")

    def test_chat_payload_requires_user_message_and_valid_conversation_id(self):
        with self.assertRaises(ValueError):
            main.ChatRequest(
                conversation_id="not-a-uuid",
                messages=[{"role": "user", "content": "Hello"}],
            )
        with self.assertRaises(ValueError):
            main.ChatRequest(
                conversation_id=str(uuid4()),
                messages=[{"role": "assistant", "content": "Hello"}],
            )

    def test_only_approved_models_are_allowed(self):
        with self.assertRaises(main.HTTPException) as result:
            main.validate_model("untrusted/model")

        self.assertEqual(result.exception.status_code, 400)

    def test_health_is_public_and_does_not_require_authentication(self):
        with patch(
            "backend.main.installed_ollama_models",
            new=AsyncMock(return_value={main.DEFAULT_MODEL}),
        ):
            response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "online")
        self.assertTrue(response.json()["ollama_available"])
        self.assertTrue(response.json()["model_available"])
        self.assertIn(main.DEFAULT_MODEL, response.json()["available_models"])

    def test_liveness_is_public_and_does_not_expose_runtime_details(self):
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_readiness_requires_the_configured_model(self):
        with patch(
            "backend.main.installed_ollama_models",
            new=AsyncMock(return_value={main.DEFAULT_MODEL}),
        ):
            ready = self.client.get("/health/ready")
        with patch("backend.main.installed_ollama_models", new=AsyncMock(return_value=set())):
            not_ready = self.client.get("/api/health/ready")

        self.assertEqual(ready.status_code, 200)
        self.assertEqual(ready.json(), {"status": "ready"})
        self.assertEqual(not_ready.status_code, 503)
        self.assertEqual(not_ready.json()["detail"], "The AI service is not ready.")

    def test_health_reports_missing_model_and_unavailable_ollama(self):
        with patch("backend.main.installed_ollama_models", new=AsyncMock(return_value=set())):
            missing_model = self.client.get("/api/health")
        with patch(
            "backend.main.installed_ollama_models",
            new=AsyncMock(side_effect=httpx.ConnectError("Ollama is unavailable")),
        ):
            unavailable = self.client.get("/api/health")

        self.assertEqual(missing_model.status_code, 200)
        self.assertTrue(missing_model.json()["ollama_available"])
        self.assertFalse(missing_model.json()["model_available"])
        self.assertEqual(missing_model.json()["available_models"], [])
        self.assertEqual(unavailable.status_code, 200)
        self.assertEqual(unavailable.json()["status"], "offline")
        self.assertFalse(unavailable.json()["ollama_available"])

    def test_available_models_requires_auth_and_reports_installed_model(self):
        token = self.make_token()
        with patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])):
            unauthorized = self.client.get("/api/models")
        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch(
                "backend.main.installed_ollama_models",
                new=AsyncMock(return_value={main.DEFAULT_MODEL}),
            ),
        ):
            authorized = self.client.get("/api/models", headers={"Authorization": f"Bearer {token}"})

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(authorized.status_code, 200)
        self.assertEqual(authorized.json()["default_model"], main.DEFAULT_MODEL)
        self.assertEqual([model["name"] for model in authorized.json()["models"]], [main.DEFAULT_MODEL])

    def test_cors_allows_production_origin_and_rejects_unapproved_origin(self):
        allowed = self.client.options(
            "/api/health",
            headers={
                "Origin": "https://rishnova-ai.pages.dev",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        rejected = self.client.options(
            "/api/health",
            headers={
                "Origin": "https://unapproved.example",
                "Access-Control-Request-Method": "GET",
            },
        )

        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers["access-control-allow-origin"], "https://rishnova-ai.pages.dev")
        self.assertIn("authorization", allowed.headers["access-control-allow-headers"].lower())
        self.assertEqual(rejected.status_code, 400)
        self.assertNotIn("access-control-allow-origin", rejected.headers)

    def test_request_body_size_limit_is_enforced(self):
        response = self.client.post(
            "/api/chat",
            content=b"{}",
            headers={"Content-Length": str(main.MAX_REQUEST_BYTES + 1)},
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Request body is too large.")
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_chat_endpoint_rejects_unauthenticated_requests(self):
        response = self.client.post(
            "/api/chat",
            json={
                "conversation_id": str(uuid4()),
                "messages": [{"role": "user", "content": "Hello"}],
                "model": main.DEFAULT_MODEL,
            },
        )

        self.assertEqual(response.status_code, 401)

    def test_invalid_chat_payload_returns_validation_error(self):
        token = self.make_token()
        with patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])):
            response = self.client.post(
                "/api/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "conversation_id": "not-a-uuid",
                    "messages": [{"role": "assistant", "content": "Hello"}],
                    "model": main.DEFAULT_MODEL,
                },
            )

        self.assertEqual(response.status_code, 422)

    def test_request_body_size_limit_also_covers_chunked_requests(self):
        async def run_middleware():
            scope = {"type": "http"}
            chunks = iter([
                {"type": "http.request", "body": b"1234", "more_body": True},
                {"type": "http.request", "body": b"5678", "more_body": False},
            ])
            sent = []
            downstream_called = False

            async def receive():
                return next(chunks)

            async def send(message):
                sent.append(message)

            async def downstream(_scope, _receive, _send):
                nonlocal downstream_called
                downstream_called = True

            middleware = main.RequestSizeLimitMiddleware(downstream, max_body_bytes=7)
            await middleware(scope, receive, send)
            return sent, downstream_called

        sent, downstream_called = asyncio.run(run_middleware())

        self.assertEqual(sent[0]["status"], 413)
        self.assertFalse(downstream_called)

    def test_cors_configuration_rejects_wildcards_and_non_loopback_http(self):
        with patch.dict("os.environ", {"CORS_ALLOWED_ORIGINS": "https://rishnova-ai.pages.dev,http://127.0.0.1:5500"}):
            origins = main.configured_origins()
        self.assertEqual(origins, ("https://rishnova-ai.pages.dev", "http://127.0.0.1:5500"))

        with patch.dict("os.environ", {"CORS_ALLOWED_ORIGINS": "*"}):
            with self.assertRaises(RuntimeError):
                main.configured_origins()
        with patch.dict("os.environ", {"CORS_ALLOWED_ORIGINS": "http://example.com"}):
            with self.assertRaises(RuntimeError):
                main.configured_origins()

    def make_token(self, **overrides):
        now = datetime.now(timezone.utc)
        claims = {
            "sub": self.user_id,
            "email": "beta-user@example.com",
            "role": "authenticated",
            "iss": f"{main.SUPABASE_URL}/auth/v1",
            "aud": "authenticated",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        }
        claims.update(overrides)
        return jwt.encode(claims, self.private_key, algorithm="RS256", headers={"kid": "test-key"})

    def test_valid_signed_supabase_token_authenticates(self):
        token = self.make_token()
        with patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])):
            response = self.client.get("/api/usage", headers={"Authorization": f"Bearer {token}"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["daily_remaining"], 40)

    def test_wrong_issuer_and_expired_tokens_are_rejected(self):
        wrong_issuer = self.make_token(iss="https://attacker.example/auth/v1")
        wrong_audience = self.make_token(aud="other")
        expired = self.make_token(exp=datetime.now(timezone.utc) - timedelta(minutes=1))
        with patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])):
            wrong_issuer_response = self.client.get(
                "/api/usage", headers={"Authorization": f"Bearer {wrong_issuer}"}
            )
            wrong_audience_response = self.client.get(
                "/api/usage", headers={"Authorization": f"Bearer {wrong_audience}"}
            )
            expired_response = self.client.get(
                "/api/usage", headers={"Authorization": f"Bearer {expired}"}
            )

        self.assertEqual(wrong_issuer_response.status_code, 401)
        self.assertEqual(wrong_audience_response.status_code, 401)
        self.assertEqual(expired_response.status_code, 401)

    def test_conversation_data_access_uses_the_verified_user_token(self):
        token = self.make_token()
        stored = [{"id": str(uuid4()), "title": "Private conversation"}]

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            self.assertEqual(user["token"], token)
            self.assertEqual((method, table), ("GET", "conversations"))
            self.assertEqual(kwargs["params"]["select"], "id,user_id,title,model,created_at,updated_at")
            return stored

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.get("/api/conversations", headers={"Authorization": f"Bearer {token}"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["conversations"], stored)

    def test_create_conversation_uses_verified_user_id(self):
        token = self.make_token()
        conversation_id = uuid4()
        created = {
            "id": str(conversation_id),
            "user_id": self.user_id,
            "title": "Cloud conversation",
        }
        calls = []

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            calls.append((method, table, kwargs))
            return [] if method == "GET" else [created]

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.post(
                "/api/conversations",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "id": str(conversation_id),
                    "title": "Cloud conversation",
                    "model": "qwen3.5:0.8b",
                    "user_id": str(uuid4()),
                    "pinned": True,
                    "project": "Personal",
                },
            )

        self.assertEqual(response.status_code, 422)

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.post(
                "/api/conversations",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "id": str(conversation_id),
                    "title": "Cloud conversation",
                    "model": "qwen3.5:0.8b",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), created)
        self.assertEqual(calls[-1][2]["body"]["user_id"], self.user_id)
        self.assertNotIn("pinned", calls[-1][2]["body"])
        self.assertNotIn("project", calls[-1][2]["body"])

    def test_update_conversation_is_scoped_to_verified_user(self):
        token = self.make_token()
        conversation_id = uuid4()

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            self.assertEqual((method, table), ("PATCH", "conversations"))
            self.assertEqual(kwargs["params"]["user_id"], f"eq.{self.user_id}")
            self.assertEqual(kwargs["body"]["title"], "Renamed cloud chat")
            return [{"id": str(conversation_id), "title": "Renamed cloud chat"}]

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.put(
                f"/api/conversations/{conversation_id}",
                headers={"Authorization": f"Bearer {token}"},
                json={"title": "Renamed cloud chat"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "Renamed cloud chat")

    def test_get_messages_checks_parent_ownership(self):
        token = self.make_token()
        conversation_id = uuid4()
        calls = []

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            calls.append((method, table, kwargs))
            if table == "conversations":
                return [{"id": str(conversation_id)}]
            return [{"role": "user", "content": "Saved in cloud"}]

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.get(
                f"/api/conversations/{conversation_id}/messages",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["messages"][0]["content"], "Saved in cloud")
        self.assertEqual([call[1] for call in calls], ["conversations", "messages"])
        self.assertEqual(calls[1][2]["params"]["user_id"], f"eq.{self.user_id}")

    def test_conversation_not_visible_to_user_returns_not_found(self):
        token = self.make_token()
        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(return_value=[])),
        ):
            response = self.client.post(
                "/api/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "conversation_id": str(uuid4()),
                    "messages": [{"role": "user", "content": "Hello"}],
                    "model": "qwen3.5:0.8b",
                },
            )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Conversation not found.")

    def test_chat_completion_persists_both_messages_in_the_owned_conversation(self):
        token = self.make_token()
        conversation_id = uuid4()
        database_calls = []

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            self.assertEqual(user["token"], token)
            database_calls.append((method, table, kwargs))
            if method == "GET" and table == "conversations":
                return [{"id": str(conversation_id), "title": "Cloud conversation", "model": main.DEFAULT_MODEL}]
            if method == "GET" and table == "messages":
                return []
            return None

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
            patch(
                "backend.main.installed_ollama_models",
                new=AsyncMock(return_value={main.DEFAULT_MODEL}),
            ),
            patch.object(
                self.client.app.state.ollama,
                "chat",
                new=AsyncMock(return_value=SimpleNamespace(message=SimpleNamespace(content="A cloud reply."))),
            ) as ollama_chat,
        ):
            response = self.client.post(
                "/api/chat",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "conversation_id": str(conversation_id),
                    "messages": [{"role": "user", "content": "Hello"}],
                    "model": main.DEFAULT_MODEL,
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reply"], "A cloud reply.")
        ollama_chat.assert_awaited_once()
        self.assertEqual(ollama_chat.await_args.kwargs["keep_alive"], -1)
        persisted_messages = [
            call[2]["body"]
            for call in database_calls
            if call[0] == "POST" and call[1] == "messages"
        ]
        self.assertEqual([message["role"] for message in persisted_messages], ["user", "assistant"])
        self.assertEqual([message["content"] for message in persisted_messages], ["Hello", "A cloud reply."])
        self.assertTrue(all(message["user_id"] == self.user_id for message in persisted_messages))

    def test_delete_hidden_conversation_returns_not_found_without_deleting(self):
        token = self.make_token()
        conversation_id = uuid4()
        calls = []

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            calls.append((method, table, kwargs))
            return []

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.delete(
                f"/api/conversations/{conversation_id}",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0:2], ("GET", "conversations"))
        self.assertEqual(calls[0][2]["params"]["user_id"], f"eq.{self.user_id}")

    def test_messages_for_hidden_conversation_return_not_found(self):
        token = self.make_token()
        conversation_id = uuid4()

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            self.assertEqual((method, table), ("GET", "conversations"))
            self.assertEqual(kwargs["params"]["user_id"], f"eq.{self.user_id}")
            return []

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.get(
                f"/api/conversations/{conversation_id}/messages",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Conversation not found.")

    def test_delete_owned_conversation_checks_owner_before_delete(self):
        token = self.make_token()
        conversation_id = uuid4()
        calls = []

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            calls.append((method, table, kwargs))
            return [{"id": str(conversation_id)}] if method == "GET" else None

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.delete(
                f"/api/conversations/{conversation_id}",
                headers={"Authorization": f"Bearer {token}"},
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual([call[0] for call in calls], ["GET", "DELETE"])
        self.assertEqual(calls[1][2]["params"]["user_id"], f"eq.{self.user_id}")


if __name__ == "__main__":
    unittest.main()
