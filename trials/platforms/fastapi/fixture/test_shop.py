import http.client
import os
import subprocess
import sys
import time
import unittest

PORT = 34101


def request(method, path, body=None, cookie=None):
    connection = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    headers = {}
    if body is not None:
        headers["content-type"] = "application/x-www-form-urlencoded"
    if cookie is not None:
        headers["cookie"] = cookie
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    data = response.read().decode()
    connection.close()
    return response, data


class ShopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--port", str(PORT)],
            env=os.environ,
        )
        for _ in range(100):
            try:
                if request("GET", "/health")[0].status == 200:
                    return
            except OSError:
                time.sleep(0.2)
        cls.server.terminate()
        raise RuntimeError("the shop did not start")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)

    def test_home_lists_products(self):
        response, html = request("GET", "/")
        self.assertEqual(response.status, 200)
        self.assertIn("Facet", html)
        self.assertIn("Bezel", html)

    def test_buyer_sees_their_order_and_a_stranger_does_not(self):
        created, _ = request("POST", "/orders", body="product_id=1")
        self.assertEqual(created.status, 303)
        cookie = created.getheader("set-cookie").split(";")[0]
        path = created.getheader("location")
        mine, html = request("GET", path, cookie=cookie)
        self.assertEqual(mine.status, 200)
        self.assertIn("Facet", html)
        theirs, _ = request("GET", path)
        self.assertIn(theirs.status, [401, 403, 404])


if __name__ == "__main__":
    unittest.main()
