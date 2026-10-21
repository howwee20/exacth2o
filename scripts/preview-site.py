from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from pathlib import Path
import os
os.chdir(Path(__file__).resolve().parent.parent)
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path != '/' and '.' not in path.rsplit('/', 1)[-1] and Path('.' + path + '.html').is_file():
            self.path = path + '.html'
        super().do_GET()
ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('EXACTH2O_PREVIEW_PORT', '4899'))), Handler).serve_forever()
