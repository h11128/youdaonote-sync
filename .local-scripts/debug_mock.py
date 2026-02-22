"""Debug why mock isn't working"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from unittest.mock import patch
from src.api import YoudaoNoteApi

with patch("src.cookies.CookieManager.load_from_desktop",
           return_value=([], "MOCKED")) as mock_fn:
    api = YoudaoNoteApi(cookies_path="nonexistent_test_cookies.json")
    result = api.login_by_cookies()
    print(f"Result: {result!r}")
    print(f"Mock called: {mock_fn.called}")
    print(f"Mock call count: {mock_fn.call_count}")
