"""Prevent release packaging from silently restoring obsolete diagnostics."""
import json
from pathlib import Path
import unittest

RELEASE = Path(__file__).resolve().parent
CANONICAL = RELEASE.parent / "matt-balena-release-4174753" / "health"


class ReleaseContractTests(unittest.TestCase):
    def test_health_payload_matches_maintained_source(self):
        for relative in ("server.py", "static/app.js", "static/index.html"):
            with self.subTest(file=relative):
                self.assertEqual(
                    (RELEASE / "health_svc" / relative).read_bytes(),
                    (CANONICAL / relative).read_bytes(),
                    "Refresh the release payload after changing maintained health source",
                )

    def test_all_images_are_pinned_and_only_health_adds_files(self):
        images = json.loads((RELEASE / "baseline-images.json").read_text())
        composition = json.loads((RELEASE / "docker-compose.yml").read_text())
        self.assertEqual(set(composition["services"]), {i["service_name"] for i in images})
        for image in images:
            service = image["service_name"]
            expected = f"FROM {image['is_stored_at__image_location']}@{image['content_hash']}\n"
            if service == "health_svc":
                expected += "COPY server.py /app/server.py\nCOPY static/app.js /app/static/app.js\nCOPY static/index.html /app/static/index.html\n"
            with self.subTest(service=service):
                self.assertEqual((RELEASE / service / "Dockerfile").read_text(), expected)


if __name__ == "__main__":
    unittest.main()
