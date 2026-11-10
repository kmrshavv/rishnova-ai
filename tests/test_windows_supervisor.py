import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from deployment.windows.supervisor import (
    Supervisor,
    parse_quick_tunnel_url,
    parse_tunnel_config,
    read_quick_tunnel_url,
)


class BackendReadinessTests(unittest.TestCase):
    def test_stop_request_wakes_supervisor_wait(self):
        supervisor = Supervisor()

        supervisor.request_stop()

        self.assertTrue(supervisor.stop_event.is_set())
        self.assertTrue(supervisor.wake_event.is_set())

    def test_requires_the_current_readiness_endpoint(self):
        supervisor = Supervisor()
        with patch(
            "deployment.windows.supervisor.fetch_json",
            return_value=(404, None),
        ) as fetch:
            self.assertFalse(supervisor.backend_ready())
        fetch.assert_called_once_with("http://127.0.0.1:8000/health/ready")

    def test_missing_cloudflared_reports_error_when_no_named_tunnel(self):
        supervisor = Supervisor()
        supervisor.cloudflared_executable = None

        self.assertFalse(supervisor.ensure_tunnel())

        self.assertEqual(supervisor.status["tunnel"], "missing_runtime")
        self.assertIn("cloudflared.exe was not found", supervisor.status["last_startup_error"])


class TunnelConfigTests(unittest.TestCase):
    def test_extracts_only_quick_tunnel_hostname_from_cloudflared_log(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "tunnel.log"
            log.write_text(
                "old https://old-name.trycloudflare.com\n"
                "new tunnel https://latest-name.trycloudflare.com\n",
                encoding="utf-8",
            )

            self.assertEqual(
                parse_quick_tunnel_url(log),
                "https://latest-name.trycloudflare.com",
            )
            self.assertEqual(
                parse_quick_tunnel_url(log, len("old https://old-name.trycloudflare.com\n")),
                "https://latest-name.trycloudflare.com",
            )

    def test_quick_tunnel_state_accepts_only_trycloudflare_https_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "quick-tunnel.json"
            config.write_text(
                '{"url":"https://sample-name.trycloudflare.com"}',
                encoding="utf-8",
            )
            self.assertEqual(
                read_quick_tunnel_url(config),
                "https://sample-name.trycloudflare.com",
            )

            config.write_text('{"url":"http://127.0.0.1:8000"}', encoding="utf-8")
            self.assertIsNone(read_quick_tunnel_url(config))

    def test_accepts_only_named_tunnel_routed_to_loopback_fastapi(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tunnel_id = str(uuid.uuid4())
            credentials = root / f"{tunnel_id}.json"
            credentials.write_text("{}", encoding="utf-8")
            config = root / "cloudflared.yml"
            config.write_text(
                "\n".join(
                    [
                        f"tunnel: {tunnel_id}",
                        f"credentials-file: '{credentials}'",
                        "ingress:",
                        "  - hostname: api.example.com",
                        "    service: http://127.0.0.1:8000",
                        "  - service: http_status:404",
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(parse_tunnel_config(config), (tunnel_id, "api.example.com"))

    def test_rejects_pages_and_quick_tunnel_hostnames(self):
        for hostname in ("rishnova-ai.pages.dev", "random.trycloudflare.com"):
            with self.subTest(hostname=hostname), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                tunnel_id = str(uuid.uuid4())
                credentials = root / f"{tunnel_id}.json"
                credentials.write_text("{}", encoding="utf-8")
                config = root / "cloudflared.yml"
                config.write_text(
                    "\n".join(
                        [
                            f"tunnel: {tunnel_id}",
                            f"credentials-file: '{credentials}'",
                            "ingress:",
                            f"  - hostname: {hostname}",
                            "    service: http://127.0.0.1:8000",
                            "  - service: http_status:404",
                        ]
                    ),
                    encoding="utf-8",
                )

                self.assertIsNone(parse_tunnel_config(config))

    def test_rejects_any_additional_service_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tunnel_id = str(uuid.uuid4())
            credentials = root / f"{tunnel_id}.json"
            credentials.write_text("{}", encoding="utf-8")
            config = root / "cloudflared.yml"
            config.write_text(
                "\n".join(
                    [
                        f"tunnel: {tunnel_id}",
                        f"credentials-file: '{credentials}'",
                        "ingress:",
                        "  - hostname: api.example.com",
                        "    service: http://127.0.0.1:8000",
                        "  - hostname: ollama.example.com",
                        "    service: http://127.0.0.1:11434",
                        "  - service: http_status:404",
                    ]
                ),
                encoding="utf-8",
            )

            self.assertIsNone(parse_tunnel_config(config))


if __name__ == "__main__":
    unittest.main()
