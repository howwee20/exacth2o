import unittest
from health_bench import bench_capture


class BenchCaptureTest(unittest.TestCase):
    def test_reads_exactly_one_verified_probe(self):
        paths = []
        def fetch(url, timeout):
            paths.append(url)
            return {"ok": True, "data": {"boardSerialId": "B", "address": "A"}}
        def parse(_):
            return {"ok": True, "timestamp": "2026-11-23T12:00:00Z", "reading": {"rawValue": 0}}
        request = {"id": ["12"], "key": ["B:A"]}
        data, status = bench_capture(request, "http://controller", fetch, parse)
        self.assertEqual((status, data["rawValue"]), (200, 0))
        self.assertEqual(paths, ["http://controller/v1/sensors/12", "http://controller/v1/sensors/12/direct-reading/1"])
        paths.clear()
        _, status = bench_capture({**request, "key": ["other"]}, "http://controller", fetch, parse)
        self.assertEqual((status, len(paths)), (409, 1))
        self.assertEqual(bench_capture({"capabilities": ["1"]}, "", None, None), ({"singleProbe": True}, 200))
