"""Dev server for the dashboard, with caching switched off.

`python -m http.server` lets the browser hold on to app.js/styles.css between
reloads. That cost real time in development: edits appeared to have no effect,
and more than once a stale file was mistaken for a bug in the code. Every
response here carries no-store, so a reload always fetches what is on disk.

Production (GitHub Pages) is unaffected — this is only for local work.

    python tools/serve.py [port]
"""
import functools
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):        # keep the console readable
        if '200' not in (args[1] if len(args) > 1 else ''):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dashboard')
    handler = functools.partial(NoCache, directory=os.path.abspath(root))
    print(f'serving {os.path.abspath(root)} on http://127.0.0.1:{port}  (no-store)')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
