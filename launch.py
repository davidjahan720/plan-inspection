"""
Lance Plan Inspection dans le navigateur.
Usage : python launch.py
"""
import http.server
import webbrowser
import threading
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

PORT = 8080
DIR  = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def log_message(self, format, *args):
        pass  # silencieux

def open_browser():
    webbrowser.open(f'http://localhost:{PORT}')

if __name__ == '__main__':
    threading.Timer(0.6, open_browser).start()
    print(f'Plan Inspection  →  http://localhost:{PORT}')
    print('Ctrl+C pour arrêter\n')
    try:
        httpd = http.server.HTTPServer(('', PORT), Handler)
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nArrêt.')
        sys.exit(0)
