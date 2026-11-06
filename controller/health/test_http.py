"""Exercise the split HTTP/auth/collector boundary without contacting a device."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import base64
import json
import threading
import unittest
from unittest.mock import patch
from test_auth import load


class HttpBoundaryTests(unittest.TestCase):
    def test_login_and_protected_collection(self):
        module = load("server", DASHBOARD_USERNAME="test", DASHBOARD_PASSWORD="local-test")
        server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = HTTPConnection(*server.server_address, timeout=3)
        try:
            with patch.object(module, "collect_health", return_value={"sample": "fixture"}) as collect:
                client.request("GET", "/login")
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b"<form", response.read())
                client.request("GET", "/api/health")
                response = client.getresponse()
                self.assertEqual(response.status, 401)
                response.read()
                collect.assert_not_called()
                token = base64.b64encode(b"test:local-test").decode()
                client.request("GET", "/api/health", headers={"Authorization": "Basic " + token})
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {"sample": "fixture"})
                collect.assert_called_once_with()
        finally:
            client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
