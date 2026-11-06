import base64
import importlib
import sys
import os
import unittest
from unittest.mock import patch

def load(module_name="health_auth", **env):
    # Configuration is read at process startup. Give each case a fresh module
    # graph so one environment cannot leak into the next case.
    with patch.dict(os.environ, env, clear=True):
        for name in list(sys.modules):
            if name.startswith("health_"):
                del sys.modules[name]
        return importlib.import_module(module_name)

class DashboardAuthTests(unittest.TestCase):
    def test_missing_or_partial_credentials_deny(self):
        for env in [{}, {"DASHBOARD_USERNAME":"test"}, {"DASHBOARD_PASSWORD":"password"}]:
            module=load(**env)
            self.assertFalse(module.check_basic_auth(""))
            self.assertFalse(module.check_bearer_token("", {}))
            self.assertFalse(module.verify_session_token(module.create_session_token("test")))

    def test_configured_basic_and_session_remain_available(self):
        for secret in [None, "", "separate-test-secret"]:
            env={"DASHBOARD_USERNAME":"test", "DASHBOARD_PASSWORD":"test-password"}
            if secret is not None: env["DASHBOARD_SESSION_SECRET"]=secret
            module=load(**env)
            header="Basic "+base64.b64encode(b"test:test-password").decode()
            self.assertTrue(module.check_basic_auth(header))
            self.assertTrue(module.check_bearer_token(header, {}))
            self.assertTrue(module.verify_session_token(module.create_session_token("test")))
            self.assertFalse(module.verify_session_token("forged"))
            self.assertNotIn(module.DASHBOARD_SESSION_SECRET,["", "replace-this-session-secret"])

    def test_explicit_development_mode(self):
        self.assertTrue(load(DASHBOARD_AUTH_DISABLED="1").check_basic_auth(""))

    def test_health_token_requires_exact_secret(self):
        module=load(HEALTHCHECK_TOKEN="test-health-token")
        self.assertTrue(module.check_bearer_token("Bearer test-health-token",{}))
        self.assertFalse(module.check_bearer_token("Bearer wrong",{}))
        self.assertFalse(module.check_bearer_token("",{}))

if __name__ == "__main__": unittest.main()
