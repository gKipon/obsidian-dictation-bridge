import base64
import hashlib
import http.client
import json
import tempfile
import io
import shutil
import wave
import sqlite3
import time
import threading
import unittest
import uuid
import os
import subprocess
import sys
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from pathlib import Path
from service import Handler, Rejection, VoiceService, probe_duration, NoRedirect, provider


def identifier(): return str(uuid.uuid4())
def digest(token): return hashlib.sha256(token.encode()).hexdigest()

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ids = [identifier(), identifier(), identifier()]
        self.config = {'state_path': str(Path(self.tmp.name) / 'state.sqlite'), 'openai_api_key': 'private-key', 'devices': [{'instance_id': i, 'token_sha256': digest('token-' + i)} for i in self.ids], 'daily_requests_limit': 10, 'max_audio_bytes': 32}
        self.calls = []
        self.service = VoiceService(self.config, self.fake, lambda audio: 2)
    def tearDown(self): self.tmp.cleanup()
    def fake(self, audio, mime, languages, keywords, key, timeout):
        self.calls.append((audio, mime, languages, keywords))
        return 'Привет 42'
    def payload(self, instance=None):
        return {'request_id': identifier(), 'instance_id': instance or self.ids[0], 'audio_base64': base64.b64encode(b'audio').decode(), 'mime': 'audio/webm;codecs=opus', 'languages': [], 'keywords': ['Example']}
    def call(self, payload, token=None):
        return self.service.handle('Bearer ' + (token or 'token-' + payload['instance_id']), payload)
    def rejected(self, code, func):
        with self.assertRaises(Rejection) as caught: func()
        self.assertEqual(caught.exception.code, code)
    def test_auth_cache_conflict_restart(self):
        p = self.payload()
        self.rejected('FORBIDDEN', lambda: self.call(p, 'token-' + self.ids[1]))
        first = self.call(p)
        self.assertEqual(first['instance_id'], self.ids[0])
        self.assertEqual(first['text'], 'Привет 42')
        self.assertEqual(self.call(p), first)
        self.assertEqual(len(self.calls), 1)
        modified = dict(p, languages=['en'])
        self.rejected('REQUEST_CONFLICT', lambda: self.call(modified))
        self.service = VoiceService(self.config, self.fake, lambda audio: 2)
        self.rejected('RESULT_EXPIRED', lambda: self.call(p))
        self.assertEqual(len(self.calls), 1)
    def test_unknown_never_replayed(self):
        self.service.upstream = lambda *args: (_ for _ in ()).throw(TimeoutError('private-key'))
        p = self.payload()
        self.rejected('PROVIDER_UNCERTAIN', lambda: self.call(p))
        self.rejected('REQUEST_UNKNOWN', lambda: self.call(p))
        self.service = VoiceService(self.config, self.fake, lambda audio: 2)
        self.rejected('REQUEST_UNKNOWN', lambda: self.call(p))
        self.assertEqual(len(self.calls), 0)
    def test_validation_and_daily_limit(self):
        for p, code in [(dict(self.payload(), audio_base64=''), 'INVALID_AUDIO'), (dict(self.payload(), audio_base64='@@@'), 'INVALID_AUDIO'), (dict(self.payload(), audio_base64=base64.b64encode(b'x'*33).decode()), 'INVALID_AUDIO'), (dict(self.payload(), mime='text/plain'), 'INVALID_MIME'), (dict(self.payload(), keywords=['<x>']), 'INVALID_REQUEST'), (dict(self.payload(), note='private'), 'INVALID_REQUEST')]:
            self.rejected(code, lambda p=p: self.call(p))
        self.service.daily_limit = 1
        self.call(self.payload())
        self.rejected('DAILY_LIMIT', lambda: self.call(self.payload()))
        self.assertEqual(len(self.calls), 1)
    def test_parallel_limits(self):
        entered = threading.Event()
        release = threading.Event()
        def blocked(*args):
            entered.set(); release.wait(3); return 'ok'
        self.service.upstream = blocked
        p = self.payload()
        t = threading.Thread(target=self.call, args=(p,))
        t.start(); self.assertTrue(entered.wait(2))
        try:
            self.rejected('BUSY', lambda: self.call(p))
            self.rejected('BUSY', lambda: self.call(self.payload()))
            other = self.payload(self.ids[1]); second = threading.Thread(target=self.call, args=(other,)); second.start()
            for _ in range(100):
                with self.service.lock:
                    if len(self.service.active) == 2: break
                threading.Event().wait(.01)
            self.rejected('BUSY', lambda: self.call(self.payload(self.ids[2])))
        finally:
            release.set(); t.join(); second.join()
    def test_daily_duration_and_cache_expiry(self):
        self.service.daily_seconds_limit = 3
        self.call(self.payload())
        self.rejected('DAILY_AUDIO_LIMIT', lambda: self.call(self.payload()))
        self.service.cache[('x', 'y')] = (time.monotonic() - 1, 'secret')
        self.service.purge_cache()
        self.assertNotIn(('x', 'y'), self.service.cache)
    def test_legacy_ledger_migration(self):
        path = str(Path(self.tmp.name) / 'legacy.sqlite')
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE requests(instance_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(instance_id,request_id))')
            db.execute('INSERT INTO requests VALUES (?,?,?,?,?)', ('i','r','h','started','2026-01-01'))
        VoiceService(dict(self.config, state_path=path), self.fake, lambda audio: 1)
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('SELECT duration FROM requests').fetchone()[0], 300)
    def test_redirect_refused(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.invalid'))
    @unittest.skipUnless(shutil.which('ffprobe'), 'ffprobe unavailable locally')
    def test_real_wav_duration(self):
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(8000)
            wav.writeframes(b'\0\0' * 8000)
        self.assertEqual(probe_duration(buf.getvalue()), 1)
    def test_auth_before_body(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler); server.service = self.service
        thread = threading.Thread(target=server.serve_forever); thread.start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
            conn.putrequest('POST', '/v1/transcribe'); conn.putheader('Content-Length', '999'); conn.putheader('Content-Type', 'application/json'); conn.endheaders()
            response = conn.getresponse(); self.assertEqual(response.status, 403); response.read(); conn.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()
    def test_http_redaction_and_health(self):
        self.service.upstream = lambda *a: (_ for _ in ()).throw(Exception('private-key secret transcript'))
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler); server.service = self.service
        thread = threading.Thread(target=server.serve_forever); thread.start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
            conn.request('GET', '/healthz'); response = conn.getresponse(); self.assertEqual(json.loads(response.read()), {'status':'ok', 'provider_ready': True})
            p = self.payload(); body = json.dumps(p)
            conn.request('POST', '/v1/transcribe', body, {'Content-Type':'application/json', 'Authorization':'Bearer token-' + p['instance_id']})
            response = conn.getresponse(); data = response.read().decode(); self.assertEqual(response.status, 502)
            self.assertNotIn('private-key', data); self.assertNotIn('secret', data); self.assertNotIn('transcript', data)
            self.assertEqual(json.loads(data)['error'], 'PROVIDER_UNCERTAIN')
            conn.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()

class PublicationTests(unittest.TestCase):
    def test_provision_file_is_private_and_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'device.json'
            script = Path(__file__).with_name('provision-device.py')
            result = subprocess.run([sys.executable, str(script), str(output)], capture_output=True, text=True, check=True)
            data = json.loads(output.read_text())
            self.assertNotIn(data['token'], result.stdout + result.stderr)
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
            self.assertEqual(data['server_device']['token_sha256'], digest(data['token']))
            self.assertEqual(data['instance_id'], data['server_device']['instance_id'])
            second = subprocess.run([sys.executable, str(script), str(output)], capture_output=True)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(json.loads(output.read_text()), data)

    def test_provider_multipart_language_hints_and_no_note_fields(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'{"text":"synthetic result"}'
        with patch('service.urllib.request.build_opener') as opener:
            opener.return_value.open.return_value = Response()
            self.assertEqual(provider(b'synthetic audio', 'audio/wav', ['en', 'ru'], ['Synthetic'], 'synthetic-key', 1), 'synthetic result')
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'https://api.openai.com/v1/audio/transcriptions')
            self.assertEqual(request.data.count(b'name="languages[]"'), 2)
            self.assertIn(b'name="keywords[]"', request.data)
            self.assertNotIn(b'name="note"', request.data)

if __name__ == '__main__': unittest.main()
