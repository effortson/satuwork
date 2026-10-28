"""Stage the app's distribution credentials and manual export options on a CI runner."""

import base64
import hashlib
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

if len(sys.argv) == 3 and sys.argv[1] == "--sign-archive":
    archive = Path(sys.argv[2]).resolve()
    info_path = archive / "Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    app = archive / "Products" / info["ApplicationProperties"]["ApplicationPath"]
    app_info = plistlib.loads((app / "Info.plist").read_bytes())
    if app_info.get("CFBundleIdentifier") != BUNDLE:
        raise SystemExit("Archive does not contain Satuwork")
    shutil.copyfile(stage / "app.mobileprovision", app / "embedded.mobileprovision")
    # Tauri's API-key archive path uses a temporary signature without the app's entitlements.
    # Export preserves requested entitlements; the profile alone does not add APNs permission.
    subprocess.run([
        "codesign", "--force", "--sign", (stage / "signing-identity.txt").read_text().strip(),
        "--keychain", str(stage.parent / "satuwork-ios-signing.keychain-db"),
        "--entitlements", str(stage / "Production.entitlements.plist"),
        "--generate-entitlement-der", str(app),
    ], check=True)
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
    details = subprocess.run(["codesign", "--display", "--verbose=4", str(app)],
                             check=True, capture_output=True, text=True).stderr
    identity = next(line.removeprefix("Authority=") for line in details.splitlines()
                    if line.startswith("Authority=Apple Distribution:"))
    info["ApplicationProperties"].update(SigningIdentity=identity, Team=TEAM)
    info_path.write_bytes(plistlib.dumps(info))
    print(f"Archive signed with production APNs: {BUNDLE}")
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
(stage / "signing-identity.txt").write_text(hashlib.sha1(profile["DeveloperCertificates"][0]).hexdigest().upper())
requested = {key: entitlements[key] for key in (
    "application-identifier", "com.apple.developer.team-identifier", "aps-environment",
    "get-task-allow", "beta-reports-active",
) if key in entitlements}
requested["keychain-access-groups"] = [f"{TEAM}.{BUNDLE}"]
(stage / "Production.entitlements.plist").write_bytes(plistlib.dumps(requested))
with (stage / "ExportOptions.plist").open("wb") as output:
    plistlib.dump({
        "method": "app-store-connect",
        "teamID": TEAM,
        "signingStyle": "manual",
        "signingCertificate": "Apple Distribution",
        "provisioningProfiles": {BUNDLE: uuid},
    }, output)
print(f"Distribution profile ready: {BUNDLE} / production APNs")
