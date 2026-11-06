"""Reporting regressions only: never connect to or mutate a controller."""
import copy
import unittest
from unittest.mock import patch
from test_auth import load


class ReportingTests(unittest.TestCase):
    def setUp(self):
        self.module = load()

    def test_archived_experiment_uses_documented_software_assignments(self):
        pairings = []
        for pot, address, valve in [(93, "o", 46), (95, "r", 48)]:
            pairings.append({"name": "Zone4-Pot%d" % pot,
                "Sensor": {"boardSerialId": "D30GQN2E", "address": address},
                "Valve": {"relayAddress": "0x20", "address": valve},
                "WTCPercentLimit": -999999, "ValveOpenTime": 10000})
        before = copy.deepcopy(pairings)
        report = self.module.validate_researcher_map(pairings)
        self.assertEqual(report["wrong"], [])
        self.assertEqual(pairings, before)
        pairings[0]["Sensor"]["address"] = "r"
        self.assertEqual(self.module.validate_researcher_map(pairings)["wrong"][0]["physicalPot"], 93)

    def status(self, count=45, jobs=45, inventory_ok=True):
        health = {"api": {"healthcheck": {"ok": True},
            "pairings": {"ok": inventory_ok, "count": count},
            "researcherMap": {"rows": []}, "boards": {"ok": True}},
            "scheduler": {"available": True, "totalPending": jobs},
            "piLocal": {"ethernet": {"linkDetected": True, "ipv4": "test"}}}
        with patch.object(self.module, "recent_restart_summary", return_value={}):
            return self.module.canonical_owner_status(health)

    def test_scheduler_counts_all_configured_pairings(self):
        status = self.status()
        self.assertEqual(status["scheduler_expected_matt_jobs"], 45)
        self.assertFalse(status["scheduler_overloaded"])
        self.assertFalse(status["active_alerts"])

    def test_real_excess_and_empty_queue_still_raise_alerts(self):
        status = self.status(jobs=46)
        self.assertTrue(status["scheduler_overloaded"])
        self.assertIn("1 excess jobs", status["active_alerts"][0])
        self.assertIn("Scheduler has no queued jobs.", self.status(jobs=0)["active_alerts"])

    def test_missing_inventory_does_not_invent_an_expected_count(self):
        status = self.status(inventory_ok=False)
        self.assertIsNone(status["scheduler_expected_matt_jobs"])
        self.assertFalse(status["scheduler_overloaded"])


if __name__ == "__main__":
    unittest.main()
