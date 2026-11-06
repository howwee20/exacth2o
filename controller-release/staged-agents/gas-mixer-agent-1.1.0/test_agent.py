"""Screen agent 1.1.0 regressions; no X11, ffmpeg, network or mixer required."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("screen_agent_110_under_test", Path(__file__).with_name("agent.py"))
agent_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent_module)

PNG_A = b"\x89PNG\r\n\x1a\n" + b"A" * 20
PNG_B = b"\x89PNG\r\n\x1a\n" + b"B" * 20


class ScriptedCloud:
    def __init__(self, responses):
        self.responses = list(responses)
        self.sent = []

    def post(self, payload):
        self.sent.append(payload)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def run_steps(agent, times, frames=(PNG_A,)):
    frames = list(frames)
    with patch.object(agent_module, "mixer_is_running", return_value=True), \
            patch.object(agent_module, "graphical_console_is_active", return_value=True), \
            patch.object(agent_module, "capture_png", side_effect=lambda: frames.pop(0) if len(frames) > 1 else frames[0]) as capture:
        for now in times:
            agent.step(now)
    return capture


class ScreenAgentTests(unittest.TestCase):
    def test_nothing_is_captured_or_uploaded_while_unattended(self):
        cloud = ScriptedCloud([{"ok": True, "commands": [], "attended": False, "next": {"hold_ms": 25000}}] * 3)
        agent = agent_module.Agent(cloud, Mock())
        capture = run_steps(agent, [0, 30, 60])
        capture.assert_not_called()
        self.assertTrue(all("frame_png_base64" not in payload for payload in cloud.sent))
        self.assertEqual([payload["hold_ms"] for payload in cloud.sent], [25000, 25000, 25000])
        self.assertTrue(all(payload["action"] == "sync" and payload["protocol"] == 2 for payload in cloud.sent))

    def test_a_new_viewer_gets_a_fresh_frame_then_only_changed_frames(self):
        attended = {"ok": True, "commands": [], "attended": True, "next": {"hold_ms": 1000, "frame_interval_ms": 1250}}
        cloud = ScriptedCloud([{"ok": True, "commands": [], "attended": True}, attended, attended, attended])
        agent = agent_module.Agent(cloud, Mock())
        run_steps(agent, [0, 0.1, 1.5, 3.0], frames=(PNG_A, PNG_A, PNG_B))
        # First sync learns a session is open; the next carries a frame at once.
        self.assertNotIn("frame_png_base64", cloud.sent[0])
        self.assertIn("frame_png_base64", cloud.sent[1])
        self.assertNotIn("frame_png_base64", cloud.sent[2])  # unchanged frame is not resent
        self.assertIn("frame_png_base64", cloud.sent[3])
        self.assertEqual(cloud.sent[1]["hold_ms"], agent_module.SESSION_HOLD_MS)

    def test_a_tap_runs_once_even_when_its_receipt_is_lost_and_it_is_redelivered(self):
        tap = {"id": "tap-1", "event_type": "tap", "normalized_x": 0.5, "normalized_y": 0.5}
        cloud = ScriptedCloud([
            {"ok": True, "commands": [tap], "attended": True},
            {"ok": True, "commands": [tap], "attended": True, "acks": [{"recorded": False, "retry": True}]},
            {"ok": True, "commands": [], "attended": True, "acks": [{"recorded": True, "retry": False}]},
        ])
        tapper = Mock()
        agent = agent_module.Agent(cloud, tapper)
        run_steps(agent, [0, 0.1, 0.2])
        tapper.tap.assert_called_once_with(0.5, 0.5)
        self.assertEqual(cloud.sent[1]["acks"], [{"command_ids": ["tap-1"], "status": "executed"}])
        self.assertEqual(cloud.sent[2]["acks"], [{"command_ids": ["tap-1"], "status": "executed"}])
        self.assertEqual(agent.acks, [])

    def test_a_failed_tap_is_reported_and_never_retried(self):
        tap = {"id": "tap-2", "event_type": "tap", "normalized_x": 0.1, "normalized_y": 0.9}
        cloud = ScriptedCloud([
            {"ok": True, "commands": [tap], "attended": True},
            {"ok": True, "commands": [tap], "attended": True, "acks": [{"recorded": True}]},
        ])
        tapper = Mock()
        tapper.tap.side_effect = RuntimeError("X11 pointer press was rejected")
        agent = agent_module.Agent(cloud, tapper)
        run_steps(agent, [0, 0.1])
        tapper.tap.assert_called_once()
        self.assertEqual(cloud.sent[1]["acks"][0]["status"], "failed")
        self.assertIn("rejected", cloud.sent[1]["acks"][0]["error"])

    def test_without_a_local_session_taps_fail_without_touching_x11(self):
        tap = {"id": "tap-3", "event_type": "tap", "normalized_x": 0.5, "normalized_y": 0.5}
        cloud = ScriptedCloud([{"ok": True, "commands": [tap], "attended": True}, {"ok": True, "commands": []}])
        agent = agent_module.Agent(cloud, None, "tap backend unavailable")
        run_steps(agent, [0, 0.1])
        self.assertEqual(cloud.sent[1]["acks"][0]["status"], "failed")

    def test_a_failed_sync_keeps_receipts_and_does_not_mark_the_frame_sent(self):
        attended = {"ok": True, "commands": [], "attended": True}
        cloud = ScriptedCloud([attended, RuntimeError("agent endpoint returned 503"), attended])
        agent = agent_module.Agent(cloud, Mock())
        agent.acks = [{"command_ids": ["tap-9"], "status": "executed"}]
        with self.assertRaises(RuntimeError):
            run_steps(agent, [0, 0.1])
        self.assertEqual(agent.acks, [{"command_ids": ["tap-9"], "status": "executed"}])
        self.assertIsNone(agent.last_frame_hash)

    def test_executed_memory_and_receipt_queue_are_bounded(self):
        cloud = ScriptedCloud([{"ok": True, "commands": [], "attended": False}] * 2)
        agent = agent_module.Agent(cloud, Mock())
        agent.executed["old"] = 0
        agent.acks = [{"command_ids": ["x{}".format(index)], "status": "executed"} for index in range(100)]
        run_steps(agent, [agent_module.EXECUTED_MEMORY_SECONDS + 1])
        self.assertNotIn("old", agent.executed)
        self.assertLessEqual(len(agent.acks), agent_module.MAX_PENDING_ACKS)


if __name__ == "__main__":
    unittest.main()
