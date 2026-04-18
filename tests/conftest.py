import os

import pytest


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_CODEX_INTEGRATION") == "1":
        return
    skip_integration = pytest.mark.skip(reason="RUN_CODEX_INTEGRATION not set")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip_integration)
