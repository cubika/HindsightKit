"""Deterministic transport fixture; replace only network calls, keep the real router."""
from types import SimpleNamespace
from unittest.mock import patch
import sys
import os
from hindsightkit.mcp import serve

class Client:
    def __init__(self, **kwargs): pass
    async def arecall(self, **kwargs):
        return SimpleNamespace(model_dump=lambda **ignored: {'results': [], 'bank': kwargs['bank_id']})
    async def aclose(self): pass

config = {'apiUrl': 'http://127.0.0.1:9077'}
if os.environ.get('TEST_FIXED_BANK'):
    config['hindsightkit'] = {'bank': os.environ['TEST_FIXED_BANK']}

with patch('hindsightkit.connection.sdk', lambda *args, **kwargs: Client()), \
     patch('hindsightkit.connection.load', return_value=config):
    serve(sys.argv[1])
