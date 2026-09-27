#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname -- "$project_dir")"
sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk_dir" ]]; then
  echo 'Set ANDROID_HOME to an Android SDK containing platform 36 and build-tools 36.0.0.' >&2
  exit 1
fi
build_tools="$sdk_dir/build-tools/36.0.0"
key_path="${PENNY_SIGNING_KEY:-$project_dir/.signing/penny-release.keystore}"
password_file="${PENNY_SIGNING_PASSWORD_FILE:-$project_dir/.signing/password.txt}"
[[ -r "$key_path" && -r "$password_file" ]] || { echo 'Restore the Penny release signing key and password file before building.' >&2; exit 1; }
[[ -x "$build_tools/apksigner" ]] || { echo 'Install Android SDK build-tools 36.0.0.' >&2; exit 1; }
version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).appVersion' "$project_dir/twa-manifest.json")"
output_dir="$repo_dir/output/android"
mkdir -p "$output_dir"
cd "$project_dir"
bash gradlew --no-daemon assembleRelease
"$build_tools/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk "$output_dir/Penny-$version-aligned.apk"
"$build_tools/apksigner" sign --ks "$key_path" --ks-key-alias penny --ks-pass "file:$password_file" --out "$output_dir/Penny-$version.apk" "$output_dir/Penny-$version-aligned.apk"
"$build_tools/apksigner" verify "$output_dir/Penny-$version.apk"
shasum -a 256 "$output_dir/Penny-$version.apk"
