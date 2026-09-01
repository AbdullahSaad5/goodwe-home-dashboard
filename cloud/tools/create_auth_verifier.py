#!/usr/bin/env python3
"""Create local Cloudflare auth secrets without echoing the passphrase."""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import secrets
from pathlib import Path

MIN_PASSPHRASE_LENGTH = 12


def write_private_json(path: Path, payload: dict[str, object]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def main() -> None:
    passphrase = getpass.getpass(
        f"Household passphrase ({MIN_PASSPHRASE_LENGTH}+ characters): "
    )
    confirmation = getpass.getpass("Repeat passphrase: ")
    if passphrase != confirmation or len(passphrase) < MIN_PASSPHRASE_LENGTH:
        raise SystemExit(
            "Passphrases did not match or were shorter than "
            f"{MIN_PASSPHRASE_LENGTH} characters"
        )
    salt = secrets.token_bytes(16)
    # Cloudflare Workers Web Crypto accepts at most 100,000 PBKDF2 iterations.
    iterations = 100_000
    verifier = {
        "algorithm": "PBKDF2-SHA256",
        "iterations": iterations,
        "salt": salt.hex(),
        "hash": hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, iterations).hex(),
    }
    private = Path(__file__).resolve().parents[2] / ".private"
    private.mkdir(mode=0o700, exist_ok=True)
    session_secret = secrets.token_hex(32)
    verifier_json = json.dumps(verifier, separators=(",", ":"))
    destination = private / "dashboard-auth.json"
    write_private_json(
        destination,
        {"PASSPHRASE_VERIFIER": verifier_json, "SESSION_SECRET": session_secret},
    )

    passphrase_path = private / "dashboard-passphrase.txt"
    temporary_passphrase = passphrase_path.with_suffix(".txt.tmp")
    temporary_passphrase.write_text(passphrase + "\n", encoding="utf-8")
    os.chmod(temporary_passphrase, 0o600)
    os.replace(temporary_passphrase, passphrase_path)

    dashboard_secrets_path = private / "dashboard-secrets.json"
    if dashboard_secrets_path.is_file():
        dashboard_secrets = json.loads(dashboard_secrets_path.read_text(encoding="utf-8"))
        dashboard_secrets["PASSPHRASE_VERIFIER"] = verifier_json
        dashboard_secrets["SESSION_SECRET"] = session_secret
        write_private_json(dashboard_secrets_path, dashboard_secrets)

    deployment_path = private / "deployment.json"
    if deployment_path.is_file():
        deployment = json.loads(deployment_path.read_text(encoding="utf-8"))
        deployment["DASHBOARD_PASSPHRASE"] = passphrase
        deployment["SESSION_SECRET"] = session_secret
        write_private_json(deployment_path, deployment)

    print("Rotated the local dashboard verifier and session secret")


if __name__ == "__main__":
    main()
