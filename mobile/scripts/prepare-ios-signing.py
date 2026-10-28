"""Stage the app's distribution credentials and manual export options on a CI runner."""

import base64
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

os.umask(0o077)
TEAM = "37TR7L5SSP"
BUNDLE = "sg.dami.satuwork.mobile"
stage = Path(os.environ["RUNNER_TEMP"]) / "satuwork-ios-signing"
profile_dirs = [
    Path.home() / "Library/MobileDevice/Provisioning Profiles",
    Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
]

if sys.argv[1:] == ["--cleanup"]:
    marker = stage / "profile-uuid.txt"
    if marker.exists():
        uuid = marker.read_text().strip()
        if not uuid or any(c not in "0123456789abcdefABCDEF-" for c in uuid):
            raise SystemExit("Invalid profile UUID")
        for directory in profile_dirs:
            (directory / f"{uuid}.mobileprovision").unlink(missing_ok=True)
    shutil.rmtree(stage, ignore_errors=True)
    raise SystemExit(0)

for name in ("IOS_DISTRIBUTION_P12_BASE64", "IOS_DISTRIBUTION_P12_PASSWORD", "IOS_PROVISIONING_PROFILE_BASE64"):
    if not os.environ.get(name):
        raise SystemExit(f"Missing {name}")

stage.mkdir(mode=0o700, parents=True, exist_ok=True)
profile_path = stage / "app.mobileprovision"
profile_path.write_bytes(base64.b64decode(os.environ["IOS_PROVISIONING_PROFILE_BASE64"], validate=True))
profile = plistlib.loads(subprocess.check_output(["security", "cms", "-D", "-i", str(profile_path)]))
entitlements = profile.get("Entitlements", {})
if (profile.get("TeamIdentifier") != [TEAM]
        or entitlements.get("application-identifier") != f"{TEAM}.{BUNDLE}"
        or entitlements.get("aps-environment") != "production"
        or entitlements.get("get-task-allow") is not False
        or "ProvisionedDevices" in profile
        or profile.get("ProvisionsAllDevices")):
    raise SystemExit("An App Store profile for Satuwork with production APNs is required")

uuid = profile["UUID"]
if not uuid or any(c not in "0123456789abcdefABCDEF-" for c in uuid):
    raise SystemExit("Invalid profile UUID")
(stage / "profile-uuid.txt").write_text(uuid)
for directory in profile_dirs:
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(profile_path, directory / f"{uuid}.mobileprovision")
(stage / "distribution.p12").write_bytes(base64.b64decode(os.environ["IOS_DISTRIBUTION_P12_BASE64"], validate=True))
with (stage / "ExportOptions.plist").open("wb") as output:
    plistlib.dump({
        "method": "app-store-connect",
        "teamID": TEAM,
        "signingStyle": "manual",
        "signingCertificate": "Apple Distribution",
        "provisioningProfiles": {BUNDLE: uuid},
    }, output)
print(f"Distribution profile ready: {BUNDLE} / production APNs")
