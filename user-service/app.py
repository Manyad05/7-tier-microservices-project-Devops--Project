"""User service: registration, login (JWT), roles."""
import json
import os
import re
import socket
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
import psycopg2
from flask import Flask, g, jsonify, request
from psycopg2 import errors as pgerrors
from psycopg2 import pool
from werkzeug.exceptions import HTTPException

HOST = socket.gethostname()
DB = dict(host=os.environ["DB_HOST"], dbname=os.environ["DB_NAME"], user=os.environ["DB_USER"],
          password=os.environ["DB_PASSWORD"], connect_timeout=5)
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_HOURS = int(os.environ.get("JWT_EXPIRES_HOURS", "12"))
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@shop.local").strip().lower()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin@123")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def log(level, msg, **kw):
    print(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), "level": level,
                      "svc": "user-service", "msg": msg, **kw}), flush=True)


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=12)).decode()


def check_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


DUMMY_HASH = hash_pw("not-a-real-password")  # keeps login timing similar for unknown emails


def init():
    """Create schema and seed the admin. Runs once (gunicorn --preload)."""
    for attempt in range(1, 41):
        try:
            c = psycopg2.connect(**DB)
            try:
                with c, c.cursor() as cur:
                    cur.execute("""CREATE TABLE IF NOT EXISTS users(
                        id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
                    cur.execute("SELECT 1 FROM users WHERE email=%s", (ADMIN_EMAIL,))
                    if not cur.fetchone():
                        cur.execute("INSERT INTO users(name,email,password_hash,role) VALUES(%s,%s,%s,'admin') "
                                    "ON CONFLICT DO NOTHING", ("Administrator", ADMIN_EMAIL, hash_pw(ADMIN_PASSWORD)))
                        log("info", "seeded admin user", email=ADMIN_EMAIL)
            finally:
                c.close()
            log("info", "database ready")
            return
        except Exception as e:  # noqa: BLE001
            log("warn", "waiting for database", attempt=attempt, err=str(e).strip())
            time.sleep(2)
    sys.exit(1)


init()

# ---- per-process connection pool (created lazily, after gunicorn forks) ----
_pool = None
_pool_pid = None


def get_pool():
    global _pool, _pool_pid
    if _pool is None or _pool_pid != os.getpid():
        _pool = pool.ThreadedConnectionPool(1, 8, **DB)
        _pool_pid = os.getpid()
    return _pool


@contextmanager
def db():
    p = get_pool()
    c = p.getconn()
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        p.putconn(c)


def to_user(r):
    return {"id": r[0], "name": r[1], "email": r[2], "role": r[3], "createdAt": r[4].isoformat()}


COLS = "id,name,email,role,created_at"


def make_token(u):
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(u["id"]), "email": u["email"], "name": u["name"], "role": u["role"],
                       "iat": now, "exp": now + timedelta(hours=JWT_HOURS)}, JWT_SECRET, algorithm="HS256")


def bad(msg, code=400):
    return jsonify(error=msg), code


def ident():
    uid = request.headers.get("X-User-Id", "")
    return (int(uid) if uid.isdigit() else None), request.headers.get("X-User-Role", "user")


def admin_only():
    uid, role = ident()
    if uid is None or role != "admin":
        return bad("admin access required", 403)
    return None


app = Flask(__name__)
app.json.sort_keys = False


@app.before_request
def _start():
    g.t0 = time.time()


@app.after_request
def _after(resp):
    resp.headers["X-Served-By"] = HOST
    if request.path not in ("/health", "/ready"):
        log("info", "req", method=request.method, path=request.path, status=resp.status_code,
            ms=int((time.time() - getattr(g, "t0", time.time())) * 1000), id=request.headers.get("X-Request-Id"))
    return resp


@app.errorhandler(Exception)
def _err(e):
    if isinstance(e, HTTPException):
        return jsonify(error=e.description), e.code
    log("error", "unhandled", err=repr(e))
    return jsonify(error="internal error"), 500


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    try:
        with db() as c, c.cursor() as cur:
            cur.execute("SELECT 1")
        return {"status": "ok", "host": HOST, "deps": {"postgres": "up"}}
    except Exception:  # noqa: BLE001
        return {"status": "down", "host": HOST, "deps": {"postgres": "down"}}, 503


@app.post("/auth/register")
def register():
    d = request.get_json(silent=True) or {}
    name = str(d.get("name", "")).strip()
    email = str(d.get("email", "")).strip().lower()
    pw = str(d.get("password", ""))
    if not 2 <= len(name) <= 80:
        return bad("Name must be 2-80 characters")
    if not EMAIL_RE.match(email) or len(email) > 254:
        return bad("Enter a valid email address")
    if len(pw) < 8 or len(pw.encode()) > 72:
        return bad("Password must be 8-72 characters")
    try:
        with db() as c, c.cursor() as cur:
            cur.execute(f"INSERT INTO users(name,email,password_hash) VALUES(%s,%s,%s) RETURNING {COLS}",
                        (name, email, hash_pw(pw)))
            u = to_user(cur.fetchone())
    except pgerrors.UniqueViolation:
        return bad("An account with this email already exists", 409)
    log("info", "user registered", user=u["id"])
    return jsonify(token=make_token(u), user=u), 201


@app.post("/auth/login")
def login():
    d = request.get_json(silent=True) or {}
    email = str(d.get("email", "")).strip().lower()
    pw = str(d.get("password", ""))
    with db() as c, c.cursor() as cur:
        cur.execute(f"SELECT {COLS},password_hash FROM users WHERE email=%s", (email,))
        r = cur.fetchone()
    ok = check_pw(pw, r[5] if r else DUMMY_HASH)
    if not r or not ok:
        return bad("Invalid email or password", 401)
    u = to_user(r)
    return jsonify(token=make_token(u), user=u)


@app.get("/auth/me")
def me():
    uid, _ = ident()
    if uid is None:
        return bad("authentication required", 401)
    with db() as c, c.cursor() as cur:
        cur.execute(f"SELECT {COLS} FROM users WHERE id=%s", (uid,))
        r = cur.fetchone()
    if not r:
        return bad("account no longer exists", 401)
    return jsonify(to_user(r))


@app.get("/users")
def list_users():
    if (e := admin_only()):
        return e
    with db() as c, c.cursor() as cur:
        cur.execute(f"SELECT {COLS} FROM users ORDER BY id")
        return jsonify([to_user(r) for r in cur.fetchall()])


@app.get("/users/stats")
def user_stats():
    if (e := admin_only()):
        return e
    with db() as c, c.cursor() as cur:
        cur.execute("SELECT count(*), count(*) FILTER (WHERE role='admin') FROM users")
        t, a = cur.fetchone()
    return jsonify(total=t, admins=a)


@app.patch("/users/<int:uid>/role")
def set_role(uid):
    if (e := admin_only()):
        return e
    me_id, _ = ident()
    role = str((request.get_json(silent=True) or {}).get("role", ""))
    if role not in ("user", "admin"):
        return bad("role must be 'user' or 'admin'")
    if uid == me_id:
        return bad("You cannot change your own role")
    with db() as c, c.cursor() as cur:
        cur.execute(f"UPDATE users SET role=%s WHERE id=%s RETURNING {COLS}", (role, uid))
        r = cur.fetchone()
    if not r:
        return bad("user not found", 404)
    return jsonify(to_user(r))
