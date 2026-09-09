"""Network-failure regressions; no Qt runtime, network, or hardware required."""

import contextlib
import importlib.util
import io
import logging
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


qt = types.ModuleType("PySide2.QtCore")
qt.QObject = object
qt.QTimer = Mock()
qt.Slot = lambda *args: lambda function: function
config = types.ModuleType("config")
config.err_thresh = 3
config.mfc_config = []
spec = importlib.util.spec_from_file_location(
    "native_bridge_under_test", Path(__file__).with_name("native_bridge.py")
)
bridge = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"PySide2": types.ModuleType("PySide2"), "PySide2.QtCore": qt, "config": config}):
    spec.loader.exec_module(bridge)


class StopAfterWaits:
    def __init__(self, count):
        self.count = count
        self.delays = []

    def is_set(self):
        return len(self.delays) >= self.count

    def wait(self, delay):
        self.delays.append(delay)


class NativeCloudTests(unittest.TestCase):
    def worker(self):
        with patch.object(bridge, "_cloud_logger", return_value=Mock()):
            worker = bridge.NativeCloudWorker()
        worker._endpoint = "https://example.invalid/native-agent"
        worker._token = "test-only-device-token"
        return worker

    def test_slow_response_has_twenty_second_network_timeout(self):
        response = Mock(status=200)
        response.read.return_value = b'{"ok":true}'
        connection = Mock()
        connection.__enter__ = Mock(return_value=response)
        connection.__exit__ = Mock(return_value=False)
        with patch.object(bridge.urllib.request, "urlopen", return_value=connection) as opened:
            self.assertEqual(bridge._post_json("https://example.invalid", "test-token", {"action": "poll"}), {"ok": True})
        self.assertEqual(opened.call_args.kwargs["timeout"], 20)

    def test_outage_backs_off_without_console_spam_and_recovers(self):
        worker = self.worker()
        worker._stop = StopAfterWaits(11)
        worker._tick = Mock(side_effect=[TimeoutError("test") for _ in range(9)] + [None, None])
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), patch.object(bridge.random, "uniform", return_value=1), patch.object(bridge.time, "monotonic", return_value=100):
            worker._run()
        self.assertEqual(worker._stop.delays, [2, 4, 8, 16, 30, 30, 30, 30, 30, 2, 2])
        worker._logger.warning.assert_called_once()
        worker._logger.info.assert_called_once()
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")

    def test_newest_state_replaces_backlog_and_commands_are_not_duplicated(self):
        worker = self.worker()
        for revision in range(1000):
            worker.publish_state({"value": revision}, revision, False)
        worker._post = Mock(return_value={"commands": [{"id": "command-1"}]})
        with patch.object(bridge.time, "monotonic", return_value=100):
            worker._tick()
            worker._tick()
        sent = [c.args[0] for c in worker._post.call_args_list]
        states = [p for p in sent if p["action"] == "state"]
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0]["observed_state"], {"value": 999})
        self.assertEqual(worker.drain_commands(), [{"id": "command-1"}])

    def test_failed_acknowledgement_is_retried_with_the_same_identity(self):
        worker = self.worker()
        payload = {"command_id": "command-1", "status": "verified"}
        worker.acknowledge(payload)
        worker._post = Mock(side_effect=[TimeoutError(), {"ok": True}])
        with self.assertRaises(TimeoutError):
            worker._send_acknowledgements()
        worker._send_acknowledgements()
        self.assertTrue(worker._acknowledgements.empty())
        self.assertEqual(worker._post.call_args_list[0], worker._post.call_args_list[1])

    def test_command_expired_in_transit_never_reaches_the_model(self):
        native = bridge.NativeBridge.__new__(bridge.NativeBridge)
        native._model = Mock()
        native._worker = Mock()
        native._command_results = {}
        native._revision = 42
        with patch.object(bridge.time, "time", return_value=2000000000):
            native.apply_commands([{
                "id": "expired-command", "expected_revision": 42,
                "expires_at": "2026-01-01T00:00:00Z",
                "payload": {"field": "use_licor", "value": True},
            }])
        self.assertEqual(native._model.mock_calls, [])
        result = native._worker.acknowledge.call_args.args[0]
        self.assertEqual(result["status"], "rejected")
        self.assertIn("expired", result["error"])

    def test_valid_command_still_applies_once_and_duplicate_only_repeats_receipt(self):
        native = bridge.NativeBridge.__new__(bridge.NativeBridge)
        native._model = Mock()
        native._worker = Mock()
        native._command_results = {}
        native._revision = 42
        native.publish_snapshot = Mock()
        command = {
            "id": "valid-command", "expected_revision": 42,
            "expires_at": "2033-05-18T03:33:35+00:00",
            "payload": {"field": "use_licor", "value": True},
        }
        with patch.object(bridge.time, "time", return_value=2000000000):
            native.apply_commands([command, command])
        native._model.set_use_licor.assert_called_once_with(True)
        self.assertEqual(
            [call.args[0]["status"] for call in native._worker.acknowledge.call_args_list],
            ["accepted", "applied", "applied"],
        )

    def test_log_write_failure_does_not_leak_into_mixer_console(self):
        with tempfile.TemporaryDirectory() as directory:
            handler = bridge.QuietRotatingFileHandler(str(Path(directory) / "cloud.log"))
            record = logging.LogRecord("test", logging.WARNING, "", 1, "Cloud request failed", (), None)
            stderr = io.StringIO()
            try:
                with patch.object(handler, "shouldRollover", side_effect=OSError("disk full")), contextlib.redirect_stderr(stderr):
                    handler.emit(record)
            finally:
                handler.close()
            self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
