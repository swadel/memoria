import json
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from pyicloud import PyiCloudService  # type: ignore
except Exception:
    try:
        # Backward compatibility path for older pyicloud-ipd installs.
        from pyicloud_ipd import PyiCloudService  # type: ignore
    except Exception:
        PyiCloudService = None


@dataclass
class Asset:
    icloud_id: str
    filename: str
    created_at: str
    mime_type: str
    file_size: int


@dataclass
class AuthAttempt:
    ok: bool
    status: str
    message: str
    error_class: str | None = None
    raw_error: str | None = None
    hint: str | None = None
    requires_2fa: bool = False
    requires_2sa: bool = False
    trusted_session: bool | None = None

    def to_response(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "error_class": self.error_class,
            "raw_error": self.raw_error,
            "hint": self.hint,
            "requires_2fa": self.requires_2fa,
            "requires_2sa": self.requires_2sa,
            "trusted_session": self.trusted_session,
            "mfa_required": self.status == "mfa_required",
        }


class AuthError(Exception):
    def __init__(self, attempt: AuthAttempt) -> None:
        super().__init__(attempt.message)
        self.attempt = attempt


def _parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _normalize_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


def _message_for_status(status: str) -> str:
    if status == "invalid_credentials":
        return "Apple rejected the Apple ID email or password before MFA."
    if status == "mfa_required":
        return "Apple accepted the password and requires a verification code."
    if status == "invalid_mfa_code":
        return "The verification code was rejected."
    if status == "adp_unsupported":
        return "Advanced Data Protection blocks web-based iCloud access."
    if status == "dependency_missing":
        return "pyicloud is not installed in this environment."
    if status == "session_required":
        return "No valid iCloud session found in the configured cookie directory."
    return "iCloud authentication failed."


def _hint_for_status(status: str, raw_error: str) -> str | None:
    lower = raw_error.lower()
    if status == "invalid_credentials":
        return (
            "If browser login works and Apple normally prompts for 2FA, "
            "this can be a pyicloud compatibility issue rather than bad credentials."
        )
    if "missing apple_id field" in lower or "srp" in lower:
        return "Apple's current login flow may not be fully compatible with pyicloud for this account."
    return None


def _raw_error(exc: Exception) -> str:
    message = str(exc).strip()
    return message or repr(exc)


def _status_from_raw_error(raw_error: str, default: str = "error") -> str:
    lower = raw_error.lower()
    if "password missing" in lower:
        return "session_required"
    if "no password entered" in lower:
        return "session_required"
    if "invalid email/password combination" in lower or "invalid email" in lower:
        return "invalid_credentials"
    if "advanced data protection" in lower or "adp" in lower:
        return "adp_unsupported"
    if "missing apple_id field" in lower or "srp" in lower:
        return "error"
    return default


def _attempt_from_exception(exc: Exception, default_status: str = "error") -> AuthAttempt:
    raw = _raw_error(exc)
    status = _status_from_raw_error(raw, default=default_status)
    return AuthAttempt(
        ok=False,
        status=status,
        message=_message_for_status(status),
        error_class=exc.__class__.__name__,
        raw_error=raw,
        hint=_hint_for_status(status, raw),
    )


def _connect(
    username: str,
    password: str | None = None,
    two_factor_code: str | None = None,
    cookie_directory: str | None = None,
) -> tuple[Any | None, AuthAttempt]:
    if PyiCloudService is None:
        return None, AuthAttempt(
            ok=False,
            status="dependency_missing",
            message=_message_for_status("dependency_missing"),
        )
    try:
        kwargs: dict[str, Any] = {}
        if cookie_directory:
            kwargs["cookie_directory"] = cookie_directory
        api = PyiCloudService(username, password, **kwargs)
    except Exception as exc:
        return None, _attempt_from_exception(exc, default_status="error")
    if getattr(api, "requires_2fa", False):
        if two_factor_code:
            try:
                ok = api.validate_2fa_code(two_factor_code)
                if ok:
                    if not getattr(api, "is_trusted_session", False):
                        try:
                            api.trust_session()
                        except Exception:
                            pass
                    return api, AuthAttempt(
                        ok=True,
                        status="valid",
                        message="iCloud authentication succeeded.",
                        requires_2fa=True,
                        trusted_session=getattr(api, "is_trusted_session", None),
                    )
                return api, AuthAttempt(
                    ok=False,
                    status="invalid_mfa_code",
                    message=_message_for_status("invalid_mfa_code"),
                    requires_2fa=True,
                )
            except Exception as exc:
                attempt = _attempt_from_exception(exc, default_status="invalid_mfa_code")
                attempt.requires_2fa = True
                return api, attempt
        return api, AuthAttempt(
            ok=False,
            status="mfa_required",
            message=_message_for_status("mfa_required"),
            requires_2fa=True,
            trusted_session=getattr(api, "is_trusted_session", None),
        )
    if getattr(api, "requires_2sa", False):
        if two_factor_code:
            try:
                devices = api.trusted_devices
                if devices:
                    api.send_verification_code(devices[0])
                    ok = api.validate_verification_code(devices[0], two_factor_code)
                    if ok:
                        return api, AuthAttempt(
                            ok=True,
                            status="valid",
                            message="iCloud authentication succeeded.",
                            requires_2sa=True,
                        )
                return api, AuthAttempt(
                    ok=False,
                    status="invalid_mfa_code",
                    message=_message_for_status("invalid_mfa_code"),
                    requires_2sa=True,
                )
            except Exception as exc:
                attempt = _attempt_from_exception(exc, default_status="invalid_mfa_code")
                attempt.requires_2sa = True
                return api, attempt
        return api, AuthAttempt(
            ok=False,
            status="mfa_required",
            message=_message_for_status("mfa_required"),
            requires_2sa=True,
        )
    return api, AuthAttempt(
        ok=True,
        status="valid",
        message="iCloud authentication succeeded.",
        trusted_session=getattr(api, "is_trusted_session", None),
    )


def list_assets(
    username: str,
    password: str | None,
    start: str,
    end: str,
    two_factor_code: str | None = None,
    cookie_directory: str | None = None,
) -> list[Asset]:
    start_dt = _parse_date(start)
    end_dt = _parse_date(end)
    api, auth = _connect(username, password, two_factor_code, cookie_directory)
    if api is None or not auth.ok:
        raise AuthError(auth)

    assets: list[Asset] = []
    photos = api.photos.all
    for item in photos:
        created = _normalize_dt(
            getattr(item, "created", None)
            or getattr(item, "date", None)
            or getattr(item, "item_date", None)
        )
        if created is None:
            continue
        if not (start_dt <= created <= end_dt):
            continue
        filename = (
            getattr(item, "filename", None)
            or getattr(item, "name", None)
            or f"{getattr(item, 'id', 'asset')}.jpg"
        )
        mime = "image/heic"
        if str(filename).lower().endswith((".mov", ".mp4")):
            mime = "video/mp4"
        assets.append(
            Asset(
                icloud_id=str(getattr(item, "id", filename)),
                filename=str(filename),
                created_at=created.isoformat(),
                mime_type=mime,
                file_size=int(getattr(item, "size", 0) or 0),
            )
        )

    return assets


def download_asset(
    username: str,
    password: str | None,
    asset_id: str,
    target_path: str,
    two_factor_code: str | None = None,
    cookie_directory: str | None = None,
) -> bool:
    api, auth = _connect(username, password, two_factor_code, cookie_directory)
    if api is None or not auth.ok:
        raise AuthError(auth)

    photos = api.photos.all
    match = None
    for item in photos:
        if str(getattr(item, "id", "")) == asset_id:
            match = item
            break
    if match is None:
        return False

    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    download_obj = match.download()
    if download_obj is None:
        return False
    content = download_obj.raw.read()
    target.write_bytes(content)
    return True


def bootstrap_session(
    username: str,
    password: str | None = None,
    two_factor_code: str | None = None,
    cookie_directory: str | None = None,
) -> dict[str, Any]:
    steps: list[str] = []
    if not cookie_directory:
        return {
            "ok": False,
            "status": "invalid_input",
            "message": "Cookie directory is required for session bootstrap.",
            "steps": ["missing_cookie_directory"],
        }

    cookie_dir = str(Path(cookie_directory))
    Path(cookie_dir).mkdir(parents=True, exist_ok=True)
    steps.append(f"cookie_dir_ready:{cookie_dir}")

    api, auth = _connect(username, password, two_factor_code, cookie_dir)
    steps.append(f"auth_status:{auth.status}")
    if api is None or not auth.ok:
        payload = auth.to_response()
        payload["steps"] = steps
        payload["cookie_directory"] = cookie_dir
        return payload

    session_path = getattr(getattr(api, "session", None), "session_path", "")
    cookiejar_path = getattr(getattr(api, "session", None), "cookiejar_path", "")
    session_token_present = bool(getattr(api, "session", None) and api.session.data.get("session_token"))
    steps.append(f"session_token_present:{session_token_present}")

    if session_path:
        steps.append(f"session_file_exists:{Path(session_path).exists()}")
    if cookiejar_path:
        steps.append(f"cookiejar_file_exists:{Path(cookiejar_path).exists()}")

    message = "Session bootstrap completed."
    if not session_token_present:
        message = "Session bootstrap partially completed; no session token found."

    return {
        "ok": session_token_present,
        "status": "session_bootstrapped" if session_token_present else "session_incomplete",
        "message": message,
        "requires_2fa": getattr(api, "requires_2fa", False),
        "requires_2sa": getattr(api, "requires_2sa", False),
        "trusted_session": getattr(api, "is_trusted_session", None),
        "cookie_directory": cookie_dir,
        "session_path": session_path,
        "cookiejar_path": cookiejar_path,
        "session_token_present": session_token_present,
        "steps": steps,
    }


def handle_command(command: dict[str, Any]) -> dict[str, Any]:
    action = command.get("action")
    if action == "ping":
        return {"ok": True, "message": "pong"}
    if action == "auth":
        username = command.get("username")
        password = command.get("password")
        two_factor_code = command.get("two_factor_code")
        cookie_directory = command.get("cookie_directory")
        if not username:
            return {"ok": False, "error": "Missing iCloud username"}
        clean_password = password if isinstance(password, str) and password.strip() else None
        _, attempt = _connect(username, clean_password, two_factor_code, cookie_directory)
        return attempt.to_response()
    if action == "list_assets":
        username = command.get("username")
        password = command.get("password")
        two_factor_code = command.get("two_factor_code")
        cookie_directory = command.get("cookie_directory")
        start = command.get("start")
        end = command.get("end")
        if not username:
            return {"ok": False, "error": "Missing iCloud username"}
        if not start or not end:
            return {"ok": False, "error": "Missing date range"}
        try:
            clean_password = password if isinstance(password, str) and password.strip() else None
            assets = [
                asdict(a)
                for a in list_assets(
                    username,
                    clean_password,
                    start,
                    end,
                    two_factor_code,
                    cookie_directory,
                )
            ]
            return {"ok": True, "assets": assets}
        except AuthError as exc:
            return exc.attempt.to_response()
        except Exception as exc:
            attempt = _attempt_from_exception(exc, default_status="error")
            attempt.message = "Failed to list iCloud assets."
            return attempt.to_response()
    if action == "download":
        username = command.get("username")
        password = command.get("password")
        two_factor_code = command.get("two_factor_code")
        cookie_directory = command.get("cookie_directory")
        asset_id = command.get("asset_id")
        target_path = command.get("target_path")
        if not username or not asset_id or not target_path:
            return {"ok": False, "error": "Missing download inputs"}
        try:
            clean_password = password if isinstance(password, str) and password.strip() else None
            ok = download_asset(
                username,
                clean_password,
                asset_id,
                target_path,
                two_factor_code,
                cookie_directory,
            )
            if ok:
                return {"ok": True}
            return {
                "ok": False,
                "status": "download_failed",
                "message": "iCloud returned no downloadable original for this asset.",
            }
        except AuthError as exc:
            return exc.attempt.to_response()
        except Exception as exc:
            attempt = _attempt_from_exception(exc, default_status="error")
            attempt.message = "Failed to download iCloud asset."
            return attempt.to_response()
    if action == "bootstrap_session":
        username = command.get("username")
        password = command.get("password")
        two_factor_code = command.get("two_factor_code")
        cookie_directory = command.get("cookie_directory")
        if not username:
            return {"ok": False, "status": "invalid_input", "message": "Missing iCloud username."}
        clean_password = password if isinstance(password, str) and password.strip() else None
        return bootstrap_session(
            username=username,
            password=clean_password,
            two_factor_code=two_factor_code,
            cookie_directory=cookie_directory,
        )
    return {"ok": False, "error": f"unknown action: {action}"}


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            response = handle_command(payload)
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
