import base64
import http.client
import importlib.util
import io
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hunan_http", ROOT / "scripts/read-hunan-http.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Socket:
    def __init__(self, body):
        self.body = body

    def makefile(self, *args):
        return io.BytesIO(self.body)


class Opener:
    def __init__(self, raw):
        self.raw = raw

    def open(self, request, timeout):
        assert request.get_header("Connection") == "close"
        assert request.get_header("Accept-encoding") == "identity"
        assert timeout == 20
        response = http.client.HTTPResponse(Socket(self.raw))
        response.begin()
        return response


class HunanHTTPTest(unittest.TestCase):
    def test_isolated_response_with_invalid_metadata_keeps_the_entire_body(self):
        body = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\x00\x01"
        opener = Opener(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.ms-excel\r\n"
                        b"Content-Length: 10\r\ninvalid metadata without a colon\r\n\r\n" + body)
        result = module.read("https://fgw.hunan.gov.cn/prices.xls", opener)
        self.assertEqual(base64.b64decode(result["base64"]), body)
        self.assertEqual(result["status"], 200)

    def test_redirect_and_access_denial_are_returned_without_following_or_reading_body(self):
        for status in (302, 403, 429, 503):
            result = module.read("https://fgw.hunan.gov.cn/prices.xls", Opener(
                f"HTTP/1.1 {status} Response\r\nLocation: https://evil.example/\r\n\r\nnot read".encode()))
            self.assertEqual(result["status"], status)
            self.assertEqual(result["base64"], "")
            self.assertEqual(result["headers"]["Location"], "https://evil.example/")

    def test_limits_host_protocol_credentials_and_body_size(self):
        for url in ("https://evil.example/", "http://fgw.hunan.gov.cn/", "https://u:p@fgw.hunan.gov.cn/"):
            with self.assertRaises(ValueError):
                module.read(url)
        with self.assertRaisesRegex(ValueError, "size limit"):
            module.read("https://fgw.hunan.gov.cn/", Opener(
                b"HTTP/1.1 200 OK\r\n\r\n" + b"x" * (module.MAX_BYTES + 1)))


if __name__ == "__main__":
    unittest.main()
