"""Create an enrollment file; never print tokens or mutate a server."""
import argparse
import hashlib
import json
import os
import secrets
import uuid
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    token = secrets.token_urlsafe(32)
    instance = str(uuid.uuid4())
    data = {'instance_id': instance, 'token': token, 'server_device': {'instance_id': instance, 'token_sha256': hashlib.sha256(token.encode()).hexdigest()}}
    fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    print('Created a private enrollment file. No server was modified.')

if __name__ == '__main__':
    main()
