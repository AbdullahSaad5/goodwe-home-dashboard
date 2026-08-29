#!/usr/bin/env python3
"""Provision the collector locally without printing or committing credentials."""

from __future__ import annotations

import argparse
import csv
import getpass
import hashlib
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

FIRMWARE = Path(__file__).resolve().parents[1]
REPOSITORY = FIRMWARE.parent
PORT = "/dev/cu.usbserial-0001"
FLASH_BYTES = 4 * 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--backup",
        type=Path,
        required=True,
        help="Path to the complete pre-write 4 MB flash backup",
    )
    return parser.parse_args()


def validate_backup(path: Path) -> str:
    if not path.is_file() or path.stat().st_size != FLASH_BYTES:
        raise SystemExit("The backup must be an existing complete 4 MB flash image")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f"Verified pre-write flash backup ({FLASH_BYTES} bytes, SHA-256 {digest}).")
    return digest


def prompt_secret(label: str, minimum: int = 1) -> str:
    value = getpass.getpass(f"{label}: ")
    if len(value) < minimum:
        raise SystemExit(f"{label} must contain at least {minimum} characters")
    return value


def idf_environment() -> dict[str, str]:
    environment = dict(os.environ)
    candidate = Path.home() / ".espressif" / "tools" / "activate_idf_v6.0.sh"
    if not candidate.exists():
        raise SystemExit("ESP-IDF 6.0 is not installed through Espressif Installation Manager")
    command = ["zsh", "-c", f"source {candidate} >/dev/null 2>&1; env -0"]
    result = subprocess.run(command, check=True, capture_output=True)
    for entry in result.stdout.split(b"\0"):
        if b"=" in entry:
            key, value = entry.split(b"=", 1)
            environment[key.decode()] = value.decode()
    return environment


def write_nvs_csv(path: Path, values: dict[str, str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["key", "type", "encoding", "value"])
        writer.writerow(["provision", "namespace", "", ""])
        for key, value in values.items():
            writer.writerow([key, "data", "string", value])


def main() -> None:
    args = parse_args()
    backup_hash = validate_backup(args.backup)
    print("Values stay local and are entered with hidden prompts where appropriate.")
    ssid = input("2.4 GHz Wi-Fi SSID: ").strip()
    wifi_password = prompt_secret("Wi-Fi password", 8)
    inverter_address = input("Optional fixed inverter IPv4 address (Enter for discovery): ").strip()
    ingest_url = input("Cloudflare ingestion URL ending /ingest/v1/batches: ").strip()
    if not ingest_url.startswith("https://") or not ingest_url.endswith("/ingest/v1/batches"):
        raise SystemExit("The ingestion URL must be HTTPS and end with /ingest/v1/batches")
    device_secret = prompt_secret("Device HMAC secret (64+ characters)", 64)
    device_id = input("Device UUID (Enter to generate): ").strip() or str(uuid.uuid4())
    try:
        uuid.UUID(device_id)
    except ValueError as error:
        raise SystemExit("Device UUID is invalid") from error
    decoder_hash = hashlib.sha256(
        (REPOSITORY / "cloud/decoder-manifest.json").read_bytes()
    ).hexdigest()

    private = REPOSITORY / ".private"
    private.mkdir(mode=0o700, exist_ok=True)
    record = private / "provisioning.json"
    record.write_text(
        json.dumps(
            {
                "device_id": device_id,
                "device_secret": device_secret,
                "decoder_hash": decoder_hash,
                "ingest_url": ingest_url,
                "pre_write_backup_sha256": backup_hash,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    record.chmod(0o600)

    values = {
        "wifi_ssid": ssid,
        "wifi_password": wifi_password,
        "inverter_addr": inverter_address,
        "ingest_url": ingest_url,
        "device_id": device_id,
        "device_secret": device_secret,
        "decoder_hash": decoder_hash,
    }
    environment = idf_environment()
    idf_path = Path(environment["IDF_PATH"])
    generator = idf_path / "components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py"
    python = Path(environment["IDF_PYTHON_ENV_PATH"]) / "bin/python"
    with tempfile.TemporaryDirectory(prefix="goodwe-provision-") as temporary:
        temporary_path = Path(temporary)
        csv_path = temporary_path / "provision.csv"
        binary_path = temporary_path / "provision.bin"
        write_nvs_csv(csv_path, values)
        subprocess.run(
            [str(python), str(generator), "generate", str(csv_path), str(binary_path), "0x6000"],
            check=True,
            cwd=FIRMWARE,
            env=environment,
        )
        print(f"Prepared firmware for {PORT}; the verified original backup will not be modified.")
        if input('Type "FLASH" to replace the current firmware: ').strip() != "FLASH":
            raise SystemExit("Cancelled without writing the ESP32")
        subprocess.run(["idf.py", "-p", PORT, "flash"], check=True, cwd=FIRMWARE, env=environment)
        subprocess.run(
            [
                str(python),
                "-m",
                "esptool",
                "--port",
                PORT,
                "write-flash",
                "0x9000",
                str(binary_path),
            ],
            check=True,
            cwd=FIRMWARE,
            env=environment,
        )
    print(
        "Provisioning complete. Secrets were not printed; "
        "the local deployment record is in .private/."
    )


if __name__ == "__main__":
    main()
