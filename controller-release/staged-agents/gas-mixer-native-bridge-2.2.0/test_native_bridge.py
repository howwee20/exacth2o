"""Bridge 2.2.0 regressions; no Qt runtime, network, or hardware required."""

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
    "native_bridge_220_under_test", Path(__file__).with_name("native_bridge.py")
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
        return False

    def set(self):
        self.count = 0


def worker():
    with patch.object(bridge, "_cloud_logger", return_value=Mock()):
        cloud = bridge.NativeCloudWorker()
    cloud._endpoint = "https://example.invalid/functions/v1/gas-mixer-native-agent"
    cloud._token = "test-only-device-token-000000000000"
    return cloud


class SyncProtocolTests(unittest.TestCase):
    def test_one_sync_carries_heartbeat_state_and_hold(self):
        cloud = worker()
        cloud.publish_state({"value": 1}, 7, True)
        cloud._post = Mock(return_value={"ok": True, "commands": [], "next": {"hold_ms": 25000, "state_interval_ms": 25000}})
        cloud._tick()
        payload, = cloud._post.call_args.args
        self.assertEqual(payload["action"], "sync")
        self.assertEqual(payload["protocol"], 2)
        self.assertEqual(payload["client_timeout_ms"], 40000)
        self.assertEqual(payload["hold_ms"], 25000)
        self.assertEqual(payload["state"]["state_revision"], 7)
        self.assertTrue(payload["state"]["sync_requested"])
        self.assertTrue(cloud._post.call_args.kwargs["holding"])

    def test_observed_only_changes_wait_for_the_state_interval_but_control_changes_do_not(self):
        cloud = worker()
        cloud._post = Mock(return_value={"ok": True, "commands": [], "next": {"hold_ms": 25000, "state_interval_ms": 25000}})
        with patch.object(bridge.time, "monotonic", return_value=100):
            cloud.publish_state({"delivered": 1.0}, 7, False)
            cloud._tick()
            cloud.publish_state({"delivered": 1.01}, 7, False)
            cloud._tick()
        self.assertIn("state", cloud._post.call_args_list[0].args[0])
        self.assertNotIn("state", cloud._post.call_args_list[1].args[0])
        with patch.object(bridge.time, "monotonic", return_value=126):
            cloud._tick()
        self.assertIn("state", cloud._post.call_args_list[2].args[0])
        with patch.object(bridge.time, "monotonic", return_value=127):
            cloud.publish_state({"delivered": 1.02}, 8, False)
            cloud._tick()
        self.assertEqual(cloud._post.call_args_list[3].args[0]["state"]["state_revision"], 8)

    def test_receipts_are_retried_until_the_server_records_them(self):
        cloud = worker()
        cloud.publish_state({"value": 1}, 7, False)
        cloud.acknowledge({"command_id": "c1", "status": "accepted"})
        cloud.acknowledge({"command_id": "c1", "status": "applied"})
        cloud.acknowledge({"command_id": "c2", "status": "rejected", "error": "Mixer state revision changed"})
        cloud._post = Mock(side_effect=[
            {"ok": True, "commands": [], "acks": [
                {"command_id": "c1", "recorded": True, "retry": False},
                {"command_id": "c1", "recorded": True, "retry": False},
                {"command_id": "c2", "recorded": False, "retry": True}]},
            {"ok": True, "commands": [], "acks": [{"command_id": "c2", "recorded": True, "retry": False}]},
        ])
        cloud._tick()
        self.assertEqual([ack["command_id"] for ack in cloud._acks], ["c2"])
        cloud._tick()
        self.assertEqual(list(cloud._acks), [])
        resent = cloud._post.call_args_list[1].args[0]["acks"]
        self.assertEqual(resent, [{"command_id": "c2", "status": "rejected", "error": "Mixer state revision changed"}])

    def test_a_failed_sync_keeps_every_receipt_in_order(self):
        cloud = worker()
        cloud.publish_state({"value": 1}, 7, False)
        cloud.acknowledge({"command_id": "c1", "status": "accepted"})
        cloud.acknowledge({"command_id": "c1", "status": "applied"})
        cloud._post = Mock(side_effect=TimeoutError())
        with self.assertRaises(TimeoutError):
            cloud._tick()
        self.assertEqual([ack["status"] for ack in cloud._acks], ["accepted", "applied"])

    def test_commands_are_delivered_once_even_when_resent(self):
        cloud = worker()
        cloud.publish_state({"value": 1}, 7, False)
        command = {"id": "command-1", "expected_revision": 7}
        cloud._post = Mock(return_value={"ok": True, "commands": [command]})
        with patch.object(bridge, "ACK_SETTLE_SECONDS", 0):
            cloud._tick()
            cloud._tick()
        self.assertEqual(cloud.drain_commands(), [command])
        self.assertEqual(cloud.drain_commands(), [])

    def test_memory_and_queues_stay_bounded(self):
        cloud = worker()
        for index in range(bridge.MAX_REMEMBERED_COMMANDS + 50):
            cloud._remember("id-{}".format(index))
        self.assertEqual(len(cloud._remembered), bridge.MAX_REMEMBERED_COMMANDS)
        self.assertNotIn("id-0", cloud._remembered)
        with patch.object(cloud, "interrupt"):
            for index in range(bridge.MAX_PENDING_ACKS + 10):
                cloud.acknowledge({"command_id": "a{}".format(index), "status": "applied"})
        self.assertEqual(len(cloud._acks), bridge.MAX_PENDING_ACKS)
        cloud.publish_state({"value": 1}, 7, False)
        burst = [{"id": "b{}".format(index)} for index in range(80)]
        cloud._post = Mock(return_value={"ok": True, "commands": burst})
        with patch.object(bridge, "ACK_SETTLE_SECONDS", 0):
            cloud._tick()
        # Commands that did not fit are not remembered, so the next sync redelivers them.
        self.assertEqual(len(cloud._commands), 64)
        self.assertNotIn("b70", cloud._remembered)

    def test_server_advice_is_bounded(self):
        cloud = worker()
        cloud.publish_state({"value": 1}, 7, False)
        cloud._post = Mock(return_value={"ok": True, "commands": [], "next": {"hold_ms": 999999, "state_interval_ms": 1}})
        cloud._tick()
        self.assertEqual(cloud._next_hold_ms, bridge.DEFAULT_HOLD_MS)
        self.assertEqual(cloud._state_interval, 1.0)
        cloud._post = Mock(return_value={"ok": True, "commands": [], "next": {"hold_ms": "bad"}})
        cloud._tick()
        self.assertEqual(cloud._next_hold_ms, bridge.DEFAULT_HOLD_MS)

    def test_more_receipts_than_one_sync_carries_skip_the_hold(self):
        cloud = worker()
        cloud.publish_state({"value": 1}, 7, False)
        with patch.object(cloud, "interrupt"):
            for index in range(bridge.MAX_ACKS_PER_SYNC + 5):
                cloud.acknowledge({"command_id": "a{}".format(index), "status": "applied"})
        cloud._post = Mock(return_value={"ok": True, "commands": []})
        cloud._tick()
        payload = cloud._post.call_args.args[0]
        self.assertEqual(payload["hold_ms"], 0)
        self.assertEqual(len(payload["acks"]), bridge.MAX_ACKS_PER_SYNC)


class LoopTests(unittest.TestCase):
    def test_outage_backs_off_with_jitter_then_recovers_without_console_spam(self):
        cloud = worker()
        cloud._stop = StopAfterWaits(99)
        cloud._state = {"value": 1}
        calls = []

        def tick():
            calls.append(1)
            if len(calls) <= 6:
                raise TimeoutError("test")
            cloud._stop.set()  # stop once the connection has recovered

        cloud._tick = tick
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                patch.object(bridge.random, "uniform", return_value=1), patch.object(bridge.time, "monotonic", return_value=100):
            cloud._run()
        self.assertEqual(cloud._stop.delays, [2, 4, 8, 16, 30, 30])
        cloud._logger.warning.assert_called_once()
        cloud._logger.info.assert_called_once()
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")

    def test_an_interrupted_hold_resends_at_once_and_is_not_a_failure(self):
        cloud = worker()
        cloud._stop = StopAfterWaits(1)
        cloud._state = {"value": 1}
        calls = []

        def tick():
            calls.append(1)
            if len(calls) == 1:
                raise bridge.Interrupted()
            raise TimeoutError("later failure")

        cloud._tick = tick
        with patch.object(bridge.random, "uniform", return_value=1):
            cloud._run()
        self.assertEqual(len(calls), 2)
        self.assertEqual(cloud._stop.delays, [2])
        cloud._logger.warning.assert_called_once()

    def test_control_changes_and_receipts_interrupt_a_hold_but_observed_jitter_does_not(self):
        cloud = worker()
        connection = Mock()
        cloud._connection = connection
        cloud._holding = True
        cloud.publish_state({"delivered": 1.0}, 7, False)
        connection.sock.shutdown.reset_mock()
        cloud.publish_state({"delivered": 1.01}, 7, False)
        connection.sock.shutdown.assert_not_called()
        cloud.publish_state({"delivered": 1.01}, 8, False)
        connection.sock.shutdown.assert_called_once()
        cloud.acknowledge({"command_id": "c1", "status": "applied"})
        self.assertEqual(connection.sock.shutdown.call_count, 2)


class QtSideTests(unittest.TestCase):
    def native(self):
        native = bridge.NativeBridge.__new__(bridge.NativeBridge)
        native._model = Mock()
        native._worker = Mock()
        native._command_results = bridge.collections.OrderedDict()
        native._revision = 42
        native._applying_cloud_command = False
        return native

    def test_command_expired_in_transit_never_reaches_the_model(self):
        native = self.native()
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

    def test_stale_revision_is_rejected_before_the_model(self):
        native = self.native()
        with patch.object(bridge.time, "time", return_value=2000000000):
            native.apply_commands([{
                "id": "stale", "expected_revision": 41,
                "expires_at": "2033-05-18T03:33:35+00:00",
                "payload": {"field": "total_slpm", "value": 3},
            }])
        self.assertEqual(native._model.mock_calls, [])
        self.assertIn("revision", native._worker.acknowledge.call_args.args[0]["error"])

    def test_valid_command_applies_once_and_duplicate_only_repeats_receipt(self):
        native = self.native()
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

    def test_balance_and_unavailable_channels_are_refused(self):
        native = self.native()
        native._mfcs = {"A": Mock(address="A", balance=True), "C": Mock(address="", balance=False)}
        with patch.object(bridge.time, "time", return_value=2000000000):
            native.apply_commands([
                {"id": "balance", "expected_revision": 42, "expires_at": "2033-05-18T03:33:35+00:00",
                 "payload": {"field": "mfc.A.ratio", "value": 50}},
                {"id": "missing", "expected_revision": 42, "expires_at": "2033-05-18T03:33:35+00:00",
                 "payload": {"field": "mfc.C.setpoint", "value": 5}},
            ])
        statuses = [call.args[0]["status"] for call in native._worker.acknowledge.call_args_list]
        self.assertEqual(statuses, ["accepted", "rejected", "accepted", "rejected"])
        native._mfcs["A"].set_ratio.assert_not_called()
        native._mfcs["C"].set_setpoint.assert_not_called()

    def test_receipt_memory_is_bounded(self):
        native = self.native()
        for index in range(bridge.MAX_REMEMBERED_COMMANDS + 5):
            native._remember_result("c{}".format(index), {"command_id": "c{}".format(index), "status": "applied"})
        self.assertEqual(len(native._command_results), bridge.MAX_REMEMBERED_COMMANDS)

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
