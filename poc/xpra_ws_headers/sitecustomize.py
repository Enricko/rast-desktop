"""PoC-only WebSocket header injector for the official native Xpra client.

The Phase 1 proof of concept rides the EXISTING authenticated HTML5 relay
(`/linux-apps/session/<key>/`), which validates a same-origin `Origin` header
and a real RAST login cookie for every WebSocket upgrade. The official Xpra
client sends neither, so for the PoC only we monkeypatch its default header
module through `sitecustomize.py` + PYTHONPATH.

Phase 3 (the native stream-token broker) makes this file unnecessary: the
token in the URL is the credential and no browser headers are required.

Loaded only when the harness explicitly sets
PYTHONPATH=<repo>/poc/xpra_ws_headers and the XPRA_POC_* environment.
Never puts secrets in argv or files; the cookie comes from the environment.
"""
import os


def _install():
    try:
        import xpra.net.websockets.headers.default as default_headers
    except Exception:
        return  # not an xpra process
    original = default_headers.get_headers
    origin = os.environ.get("XPRA_POC_ORIGIN", "").encode()
    cookie = os.environ.get("XPRA_POC_COOKIE", "").encode()

    def get_headers(host, port):
        headers = original(host, port)
        if origin:
            headers[b"Origin"] = origin
        if cookie:
            headers[b"Cookie"] = cookie
        return headers

    default_headers.get_headers = get_headers


_install()
