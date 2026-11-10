import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

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
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertIn(response.json()["status"], {"online", "offline"})

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
        expired = self.make_token(exp=datetime.now(timezone.utc) - timedelta(minutes=1))
        with patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])):
            wrong_issuer_response = self.client.get(
                "/api/usage", headers={"Authorization": f"Bearer {wrong_issuer}"}
            )
            expired_response = self.client.get(
                "/api/usage", headers={"Authorization": f"Bearer {expired}"}
            )

        self.assertEqual(wrong_issuer_response.status_code, 401)
        self.assertEqual(expired_response.status_code, 401)

    def test_conversation_data_access_uses_the_verified_user_token(self):
        token = self.make_token()
        stored = [{"id": str(uuid4()), "title": "Private conversation"}]

        async def fake_database_request(user, method, table, **kwargs):
            self.assertEqual(user["id"], self.user_id)
            self.assertEqual(user["token"], token)
            self.assertEqual((method, table), ("GET", "conversations"))
            self.assertEqual(kwargs["params"]["select"], "id,user_id,title,model,pinned,project,created_at,updated_at")
            return stored

        with (
            patch("backend.main.get_jwks", new=AsyncMock(return_value=[self.jwk])),
            patch("backend.main.database_request", new=AsyncMock(side_effect=fake_database_request)),
        ):
            response = self.client.get("/api/conversations", headers={"Authorization": f"Bearer {token}"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["conversations"], stored)

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


if __name__ == "__main__":
    unittest.main()
