#!/usr/bin/env python3
"""Create local Cloudflare auth secrets without echoing the passphrase."""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import secrets
from pathlib import Path


def main() -> None:
    passphrase = getpass.getpass("Strong household passphrase (20+ characters): ")
    confirmation = getpass.getpass("Repeat passphrase: ")
    if passphrase != confirmation or len(passphrase) < 20:
        raise SystemExit("Passphrases did not match or were shorter than 20 characters")
    salt = secrets.token_bytes(16)
    iterations = 600_000
    verifier = {
        "algorithm": "PBKDF2-SHA256",
        "iterations": iterations,
        "salt": salt.hex(),
        "hash": hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, iterations).hex(),
    }
    private = Path(__file__).resolve().parents[2] / ".private"
    private.mkdir(mode=0o700, exist_ok=True)
    destination = private / "dashboard-auth.json"
    destination.write_text(
        json.dumps(
            {
                "PASSPHRASE_VERIFIER": json.dumps(verifier, separators=(",", ":")),
                "SESSION_SECRET": secrets.token_hex(32),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    os.chmod(destination, 0o600)
    print("Saved the verifier and session secret locally in .private/dashboard-auth.json")


if __name__ == "__main__":
    main()
