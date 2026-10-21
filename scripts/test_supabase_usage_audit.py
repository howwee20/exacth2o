import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-supabase-usage.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class UsageAuditTests(unittest.TestCase):
    def test_preflights_are_excluded_but_failed_posts_still_count(self):
        report = audit.summarize([
            {"path": "/functions/v1/agent", "method": "OPTIONS", "status": "200", "calls": 1000},
            {"path": "/functions/v1/agent", "method": "POST", "status": "503", "calls": 5},
        ], 1)
        self.assertEqual(report["calls_in_window"], 5)
        self.assertEqual(report["http_errors_by_function"]["agent"], 5)

    def test_failed_requests_are_charged_and_push_rate_over_budget(self):
        report = audit.summarize([
            {"path": "/functions/v1/agent", "status": "200", "calls": 2000},
            {"path": "/functions/v1/agent", "status": "402", "calls": 1000},
        ], 1)
        self.assertEqual(report["status"], "OVER_BUDGET")
        self.assertEqual(report["calls_in_window"], 3000)
        self.assertEqual(report["projected_31_day_calls_at_observed_rate"], 2_232_000)
        self.assertEqual(report["http_errors_by_function"]["agent"], 1000)

    def test_absent_agents_are_not_mistaken_for_a_full_fleet_measurement(self):
        report = audit.summarize([{"path": "/functions/v1/lighting-native-agent", "status": "200", "calls": 600}], 1)
        self.assertEqual(report["status"], "WITHIN_BUDGET")
        self.assertEqual(report["agents_absent_from_window"], ["gas-mixer-agent", "gas-mixer-native-agent"])

    def test_empty_logs_do_not_claim_zero_usage(self):
        with self.assertRaises(ValueError):
            audit.summarize([], 1)


if __name__ == "__main__":
    unittest.main()
