import urllib.request
import json
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
payload_path = os.path.join(script_dir, 'test_payload.json')

with open(payload_path, 'rb') as f:
    data = f.read()

req = urllib.request.Request(
    'http://localhost:3000/enrich-batch',
    data=data,
    headers={'Content-Type': 'application/json'},
    method='POST'
)

try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode())
except Exception as e:
    print('ERROR:', e)
