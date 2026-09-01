import hashlib
import hmac
import time
from collections.abc import Callable
from threading import Lock
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, Header, HTTPException, Request, status
from jwt import InvalidTokenError

from app.core.config import Settings, get_settings
from app.models import Role, UserContext

_nonce_lock = Lock()
_seen_nonces: dict[str, int] = {}


def canonical_hmac_payload(
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    body: bytes,
) -> bytes:
    body_digest = hashlib.sha256(body).hexdigest()
    return "\n".join((method.upper(), path, timestamp, nonce, body_digest)).encode()


def sign_hmac(
    secret: str,
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    body: bytes,
) -> str:
    payload = canonical_hmac_payload(method, path, timestamp, nonce, body)
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


async def verify_hermes_hmac(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    x_d89_key_id: Annotated[str | None, Header()] = None,
    x_d89_timestamp: Annotated[str | None, Header()] = None,
    x_d89_nonce: Annotated[str | None, Header()] = None,
    x_d89_signature: Annotated[str | None, Header()] = None,
) -> None:
    if not all((x_d89_key_id, x_d89_timestamp, x_d89_nonce, x_d89_signature)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Firma HMAC incompleta")
    if x_d89_key_id != settings.hermes_hmac_key_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Identificador HMAC desconocido")
    try:
        request_time = int(x_d89_timestamp)
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Timestamp HMAC inválido") from exc

    now = int(time.time())
    if abs(now - request_time) > settings.hmac_tolerance_seconds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Firma HMAC expirada")

    body = await request.body()
    expected = sign_hmac(
        settings.hermes_hmac_secret,
        request.method,
        request.url.path,
        x_d89_timestamp,
        x_d89_nonce,
        body,
    )
    if not hmac.compare_digest(expected, x_d89_signature):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Firma HMAC inválida")

    with _nonce_lock:
        expired = [nonce for nonce, seen_at in _seen_nonces.items() if now - seen_at > 300]
        for nonce in expired:
            del _seen_nonces[nonce]
        if x_d89_nonce in _seen_nonces:
            raise HTTPException(status.HTTP_409_CONFLICT, "Nonce HMAC reutilizado")
        _seen_nonces[x_d89_nonce] = now


def decode_user_token(token: str, settings: Settings) -> UserContext:
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
        role = Role(claims.get("app_metadata", {}).get("role", "operativo"))
        return UserContext(id=UUID(claims["sub"]), role=role, phone=claims.get("phone"))
    except (InvalidTokenError, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sesión inválida") from exc


async def get_current_user(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> UserContext:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Se requiere sesión")
    return decode_user_token(authorization.removeprefix("Bearer ").strip(), settings)


def require_roles(*roles: Role) -> Callable[[UserContext], UserContext]:
    async def dependency(
        user: Annotated[UserContext, Depends(get_current_user)],
    ) -> UserContext:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Permiso insuficiente")
        return user

    return dependency


AdminUser = Annotated[UserContext, Depends(require_roles(Role.ADMIN))]
CurrentUser = Annotated[UserContext, Depends(get_current_user)]
HermesSignature = Annotated[None, Depends(verify_hermes_hmac)]
