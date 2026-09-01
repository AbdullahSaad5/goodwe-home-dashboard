#!/usr/bin/env python3
"""Provision the collector locally without printing or committing credentials."""

from __future__ import annotations

import argparse
import csv
import getpass
import hashlib
import ipaddress
import json
import os
import subprocess
import tempfile
import urllib.request
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
    parser.add_argument(
        "--deployment",
        type=Path,
        default=REPOSITORY / ".private/deployment.json",
        help="Local private deployment record containing the ESP32 cloud identity",
    )
    parser.add_argument(
        "--environment-file",
        type=Path,
        default=REPOSITORY / ".env",
        help="Local desktop environment file containing the validated inverter address",
    )
    parser.add_argument(
        "--nvs-only",
        action="store_true",
        help="Write only the provisioning partition; preserve the application and archive partitions",
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


def read_environment(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def active_inverter_address(environment_file: Path) -> str:
    configured = read_environment(environment_file).get("GOODWE_HOST", "")
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/api/v1/health", timeout=2) as response:
            payload = json.load(response)
        candidate = str(payload.get("host", ""))
        ipaddress.ip_address(candidate)
        if payload.get("ok") is True and payload.get("state") == "live":
            print("Loaded the currently validated inverter address from the local collector.")
            return candidate
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    print("Loaded the configured inverter address from the local environment file.")
    return configured


def load_cloud_identity(path: Path) -> tuple[str, str, str]:
    if not path.is_file():
        raise SystemExit(f"Local deployment record does not exist: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    device_id = str(payload.get("DEVICE_ID", ""))
    device_secret = str(payload.get("DEVICE_SECRET", ""))
    ingestion_url = str(payload.get("INGESTION_URL", "")).rstrip("/")
    if not ingestion_url.endswith("/ingest/v1/batches"):
        ingestion_url += "/ingest/v1/batches"
    if len(device_secret) < 64:
        raise SystemExit("The local deployment record has no valid device secret")
    try:
        uuid.UUID(device_id)
    except ValueError as error:
        raise SystemExit("The local deployment record has no valid device UUID") from error
    if not ingestion_url.startswith("https://"):
        raise SystemExit("The local deployment record has no HTTPS ingestion URL")
    return device_id, device_secret, ingestion_url


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
    if not ssid:
        raise SystemExit("Wi-Fi SSID cannot be empty")
    wifi_password = prompt_secret("Wi-Fi password", 8)
    inverter_address = active_inverter_address(args.environment_file)
    device_id, device_secret, ingest_url = load_cloud_identity(args.deployment)
    print("Loaded the inverter address and cloud identity from private local files.")
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
    idf_command = idf_path / "tools/idf.py"
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
        if args.nvs_only:
            print(f"Prepared NVS provisioning for {PORT}; application and archive data will be preserved.")
            if input('Type "WRITE" to replace the provisioning partition: ').strip() != "WRITE":
                raise SystemExit("Cancelled without writing the ESP32")
        else:
            print(f"Prepared firmware for {PORT}; the verified original backup will not be modified.")
            if input('Type "FLASH" to replace the current firmware: ').strip() != "FLASH":
                raise SystemExit("Cancelled without writing the ESP32")
            subprocess.run(
                [str(python), str(idf_command), "-p", PORT, "flash"],
                check=True,
                cwd=FIRMWARE,
                env=environment,
            )
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
