"""Deterministic transport fixture; replace only network calls, keep the real router."""
from types import SimpleNamespace
from unittest.mock import patch
import sys
from provenloop.mcp import serve

class Client:
    def __init__(self, **kwargs): pass
    async def arecall(self, **kwargs):
        return SimpleNamespace(model_dump=lambda **ignored: {'results': [], 'bank': kwargs['bank_id']})
    async def aclose(self): pass

with patch('provenloop.mcp.Hindsight', Client), \
     patch('provenloop.mcp.profile_config', return_value=({}, SimpleNamespace(port=9077))):
    serve(sys.argv[1])
