"""Read Hunan's public HTTPS responses with the standard library header parser."""
import base64
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 5_000_000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def read(url, opener=None):
    target = urllib.parse.urlsplit(url)
    if (target.scheme != "https" or target.hostname != "fgw.hunan.gov.cn"
            or target.username or target.password or target.port not in (None, 443)):
        raise ValueError("Only the official Hunan HTTPS host is allowed")
    if opener is None:
        context = ssl.create_default_context()
        # Hunan requires the same standard curve used by the existing TLS adapter.
        context.set_ecdh_curve("prime256v1")
        opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))
    request = urllib.request.Request(url, headers={"Accept-Encoding": "identity", "Connection": "close"})
    try:
        response = opener.open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        # http.client consumes the complete header block before email.parser
        # tolerates malformed metadata. One request per connection prevents any
        # ambiguous trailing bytes from being reused as another HTTP response.
        body = response.read(MAX_BYTES + 1) if 200 <= response.status < 300 else b""
        if len(body) > MAX_BYTES:
            raise ValueError("Official response exceeds the size limit")
        return {"status": response.status, "headers": {
            key: response.headers[key] for key in ("Content-Type", "Location") if response.headers.get(key)
        }, "base64": base64.b64encode(body).decode("ascii")}


if __name__ == "__main__":
    try:
        print(json.dumps(read(sys.argv[1])))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
