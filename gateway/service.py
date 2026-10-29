"""Dictation Bridge service. No request contents are written to logs or durable storage."""
import argparse
import base64
import binascii
import contextlib
import datetime
import hashlib
import hmac
import json
import os
import re
import sqlite3
import subprocess
import shutil
import math
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

URL = 'https://api.openai.com/v1/audio/transcriptions'
MODEL = 'gpt-transcribe'
MIMES = {'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav'}

class Rejection(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def uid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def mime_base(value):
    if not isinstance(value, str):
        raise Rejection(400, 'INVALID_MIME')
    parts = value.split(';')
    base = parts.pop(0).strip().lower()
    if base not in MIMES or any(not re.fullmatch(r'\s*codecs\s*=\s*"?[a-zA-Z0-9.,_-]+"?\s*', part) for part in parts):
        raise Rejection(400, 'INVALID_MIME')
    return base


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe_duration(audio):
    """Use bounded packet timing; ffprobe reads stdin, never creates an audio file."""
    proc = subprocess.Popen([shutil.which('ffprobe') or '/usr/bin/ffprobe', '-v', 'error', '-protocol_whitelist', 'pipe', '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,wav', '-select_streams', 'a', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', '-i', 'pipe:0'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    output = bytearray()
    overflow = threading.Event()
    def write_input():
        try:
            proc.stdin.write(audio)
            proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
    def read_output():
        try:
            while True:
                chunk = proc.stdout.read(8192)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 2 * 1024 * 1024:
                    overflow.set()
                    proc.kill()
                    break
        except (OSError, ValueError):
            pass
    writer = threading.Thread(target=write_input, daemon=True)
    reader = threading.Thread(target=read_output, daemon=True)
    writer.start(); reader.start()
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill(); proc.wait()
        raise ValueError('probe timeout')
    finally:
        writer.join(timeout=1); reader.join(timeout=1)
        proc.stdout.close()
    if proc.returncode != 0 or overflow.is_set() or reader.is_alive():
        raise ValueError('invalid audio')
    earliest = None; latest = None; total = 0.0
    for line in output.decode('ascii').splitlines():
        fields = line.split(',')
        try:
            pts = float(fields[0])
            duration = float(fields[1]) if len(fields) > 1 and fields[1] != 'N/A' else 0.0
        except (ValueError, IndexError):
            continue
        if not math.isfinite(pts) or not math.isfinite(duration) or duration < 0:
            raise ValueError('invalid packet timing')
        earliest = pts if earliest is None else min(earliest, pts)
        latest = pts + duration if latest is None else max(latest, pts + duration)
        total += duration
    if earliest is None or latest is None:
        raise ValueError('missing packet timing')
    seconds = max(latest - earliest, total)
    if not math.isfinite(seconds) or seconds <= 0 or seconds > 300.000001:
        raise ValueError('invalid duration')
    return math.ceil(seconds - 0.000001)


def provider(audio, mime, languages, keywords, key, timeout):
    boundary = 'dictation-bridge-' + uuid.uuid4().hex
    chunks = []
    def field(name, value):
        chunks.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n').encode())
    field('model', MODEL)
    for language in languages:
        field('languages[]', language)
    for term in keywords:
        field('keywords[]', term)
    chunks.append((f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.{MIMES[mime]}"\r\nContent-Type: {mime}\r\n\r\n').encode())
    chunks.extend([audio, f'\r\n--{boundary}--\r\n'.encode()])
    request = urllib.request.Request(URL, data=b''.join(chunks), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'multipart/form-data; boundary=' + boundary}, method='POST')
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
        data = json.loads(response.read(500_001))
    text = data.get('text') if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 100_000:
        raise ValueError('invalid provider response')
    return text


class VoiceService:
    def __init__(self, config, upstream=provider, duration_probe=probe_duration):
        self.config = config
        self.upstream = upstream
        self.duration_probe = duration_probe
        self.probe_slots = threading.BoundedSemaphore(2)
        self.max_bytes = config.get('max_audio_bytes', 5 * 1024 * 1024)
        self.daily_limit = config.get('daily_requests_limit', 120)
        self.daily_seconds_limit = config.get('daily_audio_seconds_limit', 3600)
        self.timeout = config.get('provider_timeout', 75)
        if type(self.max_bytes) is not int or not 1 <= self.max_bytes <= 20 * 1024 * 1024 or type(self.daily_limit) is not int or not 1 <= self.daily_limit <= 10000 or type(self.timeout) not in (int, float) or not 1 <= self.timeout <= 300:
            raise ValueError('invalid limits')
        if type(self.daily_seconds_limit) is not int or not 1 <= self.daily_seconds_limit <= 86400:
            raise ValueError('invalid audio limit')
        self.devices = {}
        for device in config.get('devices', []):
            instance, digest = device.get('instance_id'), device.get('token_sha256')
            if not uid(instance) or not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest) or instance in self.devices:
                raise ValueError('invalid devices')
            self.devices[instance] = digest
        self.lock = threading.Lock()
        self.active = set()
        self.cache = {}
        self.state_path = config['state_path']
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS requests (instance_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, day TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 300, PRIMARY KEY(instance_id, request_id))')
            if 'duration' not in [row[1] for row in db.execute('PRAGMA table_info(requests)')]:
                db.execute('ALTER TABLE requests ADD COLUMN duration INTEGER NOT NULL DEFAULT 300')

    @contextlib.contextmanager
    def db(self):
        db = sqlite3.connect(self.state_path, timeout=10, isolation_level=None)
        try:
            db.execute('PRAGMA busy_timeout=10000')
            yield db
        finally:
            db.close()

    def authenticate(self, auth):
        token = auth[7:] if isinstance(auth, str) and auth.startswith('Bearer ') else ''
        actual = hashlib.sha256(token.encode()).hexdigest()
        return bool(token) and any(hmac.compare_digest(expected, actual) for expected in self.devices.values())

    def purge_cache(self):
        now = time.monotonic()
        with self.lock:
            self.cache = {k: v for k, v in self.cache.items() if v[0] > now}

    def provider_ready(self):
        key = self.config.get('openai_api_key')
        return isinstance(key, str) and bool(key.strip()) and '\r' not in key and '\n' not in key

    def handle(self, auth, payload):
        instance = payload.get('instance_id') if isinstance(payload, dict) else None
        if not uid(instance):
            raise Rejection(400, 'INVALID_ID')
        token = auth[7:] if isinstance(auth, str) and auth.startswith('Bearer ') else ''
        expected = self.devices.get(instance)
        if not token or not expected or not hmac.compare_digest(expected, hashlib.sha256(token.encode()).hexdigest()):
            raise Rejection(403, 'FORBIDDEN')
        with self.lock:
            if len(self.active) >= 2 or instance in self.active:
                raise Rejection(429, 'BUSY')
            self.active.add(instance)
        try:
            return self._handle(auth, payload)
        finally:
            with self.lock:
                self.active.discard(instance)

    def _handle(self, auth, payload):
        rid = payload.get('request_id') if isinstance(payload, dict) else None
        instance = payload.get('instance_id') if isinstance(payload, dict) else None
        if not uid(rid) or not uid(instance):
            raise Rejection(400, 'INVALID_ID')
        expected = self.devices.get(instance)
        token = auth[7:] if isinstance(auth, str) and auth.startswith('Bearer ') else ''
        actual = hashlib.sha256(token.encode()).hexdigest()
        if not expected or not token or not hmac.compare_digest(expected, actual):
            raise Rejection(403, 'FORBIDDEN')
        if set(payload) != {'request_id', 'instance_id', 'audio_base64', 'mime', 'languages', 'keywords'}:
            raise Rejection(400, 'INVALID_REQUEST')
        mime = mime_base(payload['mime'])
        languages, keywords, encoded = payload['languages'], payload['keywords'], payload['audio_base64']
        if not isinstance(languages, list) or len(languages) > 8 or any(not isinstance(l, str) or not re.fullmatch('[a-z]{2,3}', l) for l in languages) or not isinstance(keywords, list) or len(keywords) > 50 or any(not isinstance(k, str) or not k.strip() or len(k) > 100 or any(c in k for c in '<>\r\n') for k in keywords):
            raise Rejection(400, 'INVALID_REQUEST')
        if not isinstance(encoded, str) or len(encoded) > ((self.max_bytes + 2) // 3) * 4:
            raise Rejection(413, 'INVALID_AUDIO')
        try:
            audio = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise Rejection(400, 'INVALID_AUDIO')
        if not audio or len(audio) > self.max_bytes:
            raise Rejection(413, 'INVALID_AUDIO')
        key = self.config.get('openai_api_key')
        if not self.provider_ready():
            raise Rejection(503, 'PROVIDER_UNAVAILABLE')
        # Hash canonical request content, never persist audio or recognized text.
        digest = hashlib.sha256(json.dumps([encoded, mime, languages, keywords], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        cache_key = (instance, rid)
        if not self.probe_slots.acquire(blocking=False):
            raise Rejection(429, 'BUSY')
        try:
            try:
                duration = self.duration_probe(audio)
                if type(duration) is not int or not 1 <= duration <= 300:
                    raise ValueError('invalid duration')
            except Exception:
                raise Rejection(400, 'INVALID_AUDIO_DURATION')
        finally:
            self.probe_slots.release()
        now = time.monotonic()
        with self.lock:
            self.cache = {k: v for k, v in self.cache.items() if v[0] > now}
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT payload_hash, status FROM requests WHERE instance_id=? AND request_id=?', cache_key).fetchone()
                if row:
                    db.execute('ROLLBACK')
                    if row[0] != digest:
                        raise Rejection(409, 'REQUEST_CONFLICT')
                    cached = self.cache.get(cache_key)
                    if cached:
                        return {'request_id': rid, 'instance_id': instance, 'text': cached[1], 'model': MODEL}
                    raise Rejection(409, 'RESULT_EXPIRED' if row[1] == 'complete' else 'REQUEST_UNKNOWN')
                day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
                count = db.execute('SELECT count(*) FROM requests WHERE day=?', (day,)).fetchone()[0]
                if count >= self.daily_limit:
                    db.execute('ROLLBACK')
                    raise Rejection(429, 'DAILY_LIMIT')
                used = db.execute('SELECT coalesce(sum(duration),0) FROM requests WHERE day=?', (day,)).fetchone()[0]
                if used + duration > self.daily_seconds_limit:
                    db.execute('ROLLBACK')
                    raise Rejection(429, 'DAILY_AUDIO_LIMIT')
                db.execute('INSERT INTO requests (instance_id,request_id,payload_hash,status,day,duration) VALUES (?,?,?,?,?,?)', (instance, rid, digest, 'started', day, duration))
                db.execute('COMMIT')
        try:
            text = self.upstream(audio, mime, languages, keywords, key, self.timeout)
            if not isinstance(text, str) or not text.strip() or len(text) > 100000:
                raise ValueError('invalid response')
            with self.lock:
                with self.db() as db:
                    db.execute("UPDATE requests SET status='complete' WHERE instance_id=? AND request_id=?", cache_key)
                if len(self.cache) >= 100:
                    del self.cache[next(iter(self.cache))]
                self.cache[cache_key] = (time.monotonic() + 900, text)
            return {'request_id': rid, 'instance_id': instance, 'text': text, 'model': MODEL}
        except Exception:
            # Any upstream failure may have happened after dispatch. Never replay this ID.
            raise Rejection(502, 'PROVIDER_UNCERTAIN')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == '/healthz':
            self.reply(200, {'status': 'ok', 'provider_ready': self.server.service.provider_ready()})
        else:
            self.reply(404, {'error': 'NOT_FOUND'})

    def do_POST(self):
        payload = None
        try:
            if self.path != '/v1/transcribe':
                raise Rejection(404, 'NOT_FOUND')
            if not self.server.service.authenticate(self.headers.get('Authorization')):
                raise Rejection(403, 'FORBIDDEN')
            if self.headers.get_content_type() != 'application/json' or self.headers.get('Transfer-Encoding'):
                raise Rejection(400, 'INVALID_REQUEST')
            if len(self.headers.get_all('Content-Length', [])) != 1 or len(self.headers.get_all('Authorization', [])) > 1:
                raise Rejection(400, 'INVALID_REQUEST')
            raw_length = self.headers.get('Content-Length', '')
            if not re.fullmatch(r'[0-9]{1,10}', raw_length):
                raise Rejection(400, 'INVALID_LENGTH')
            length = int(raw_length)
            if length < 1 or length > ((self.server.service.max_bytes + 2) // 3) * 4 + 16384:
                raise Rejection(413, 'INVALID_LENGTH')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise Rejection(400, 'INVALID_REQUEST')
            try:
                payload = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise Rejection(400, 'INVALID_REQUEST')
            self.reply(200, self.server.service.handle(self.headers.get('Authorization'), payload))
        except Rejection as exc:
            result = {'error': exc.code}
            if isinstance(payload, dict):
                for field in ('request_id', 'instance_id'):
                    if uid(payload.get(field)):
                        result[field] = payload[field]
            self.reply(exc.status, result)
        except Exception:
            self.reply(500, {'error': 'INTERNAL_ERROR'})


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, *args):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args)

    def service_actions(self):
        self.service.purge_cache()

    def handle_error(self, request, client_address):
        pass

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(15)
        return request, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    with open(args.config, encoding='utf-8') as f:
        config = json.load(f)
    config['openai_api_key'] = os.environ.get('OPENAI_API_KEY', '')
    service = VoiceService(config)
    port = config.get('port', 8897)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('invalid port')
    server = BoundedServer(('127.0.0.1', port), Handler)
    server.service = service
    server.serve_forever()

if __name__ == '__main__':
    main()
