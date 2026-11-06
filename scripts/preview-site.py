from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from pathlib import Path
import os
os.chdir(Path(__file__).resolve().parent.parent)
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Local edits should appear immediately, including in already-open tabs.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path != '/' and '.' not in path.rsplit('/', 1)[-1] and Path('.' + path + '.html').is_file():
            self.path = path + '.html'
        super().do_GET()
# Parallel browser checks request many modules at once.
ThreadingHTTPServer.request_queue_size = 64
ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('EXACTH2O_PREVIEW_PORT', '4899'))), Handler).serve_forever()
