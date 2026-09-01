import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
import uuid

from .schemas import TOOL_SCHEMAS


def _call_api(tool_name, params, **kwargs):
    base_url = os.environ["D89_API_URL"].rstrip("/")
    path = f"/api/v1/hermes/tools/{tool_name}"
    body = json.dumps(params, ensure_ascii=False, separators=(",", ":")).encode()
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = "\n".join(("POST", path, timestamp, nonce, body_hash)).encode()
    signature = hmac.new(
        os.environ["HERMES_HMAC_SECRET"].encode(), canonical, hashlib.sha256
    ).hexdigest()
    sender = kwargs.get("sender_id") or kwargs.get("user_id") or ""
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-D89-Key-Id": os.environ["HERMES_HMAC_KEY_ID"],
            "X-D89-Timestamp": timestamp,
            "X-D89-Nonce": nonce,
            "X-D89-Signature": signature,
            "X-D89-Actor-Phone": str(sender),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode()
    except urllib.error.HTTPError as exc:
        safe_body = exc.read(4096).decode(errors="replace")
        return json.dumps({"success": False, "status": exc.code, "detail": safe_body})


def register(ctx):
    for schema in TOOL_SCHEMAS:
        name = schema["name"]

        def handler(params, _name=name, **kwargs):
            return _call_api(_name, params, **kwargs)

        ctx.register_tool(
            name=name,
            toolset="d89",
            schema=schema,
            handler=handler,
            description=schema["description"],
        )
