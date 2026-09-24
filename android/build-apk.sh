#!/usr/bin/env bash
# Fabula Board APK builder — CI (Ubuntu / GitHub Actions) edition.
# Mirrors android/build-apk.ps1; no Gradle: aapt2 + javac + d8 + zipalign + apksigner.
# Requires: JDK 17 on PATH (setup-java), ANDROID_HOME with platforms;android-34 + build-tools;34.0.0.
# Output:   android/build/Fabula-Board.apk (debug-signed via repo keystore, installable)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then echo "ERROR: ANDROID_HOME not set" >&2; exit 1; fi
if [ -d "$SDK/build-tools/34.0.0" ]; then
  BT="$SDK/build-tools/34.0.0"
else
  BT="$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
fi
BT="${BT%/}"
PLAT="$SDK/platforms/android-34/android.jar"
[ -x "$BT/aapt2" ] || { echo "ERROR: aapt2 not found in $BT" >&2; exit 1; }
[ -f "$PLAT" ] || { echo "ERROR: missing $PLAT" >&2; exit 1; }

OUT="$HERE/build"
WORK="$HERE/.work"
rm -rf "$WORK"
mkdir -p "$OUT" "$WORK/gen" "$WORK/classes" "$WORK/dex"

echo "1/7 icons (node tools/make-icon.mjs -> build/ + android res)"
(cd "$ROOT" && node tools/make-icon.mjs)

echo "2/7 aapt2 compile"
"$BT/aapt2" compile --dir "$HERE/res" -o "$WORK/res.zip"

echo "3/7 aapt2 link"
"$BT/aapt2" link -o "$WORK/base.apk" -I "$PLAT" \
  --manifest "$HERE/AndroidManifest.xml" -R "$WORK/res.zip" --java "$WORK/gen" \
  --min-sdk-version 24 --target-sdk-version 34

echo "4/7 javac"
mapfile -t SRCS < <(find "$HERE/src" "$WORK/gen" -name '*.java')
javac --release 11 -encoding UTF-8 -Xlint:none -classpath "$PLAT" -d "$WORK/classes" "${SRCS[@]}"

echo "5/7 d8"
mapfile -t CLASSES < <(find "$WORK/classes" -name '*.class')
"$BT/d8" --lib "$PLAT" --min-api 24 --output "$WORK/dex" "${CLASSES[@]}"

echo "6/7 pack dex + zipalign"
cp "$WORK/base.apk" "$WORK/unsigned.apk"
jar --update --file "$WORK/unsigned.apk" -C "$WORK/dex" classes.dex
"$BT/zipalign" -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"

echo "7/7 sign"
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  # 仓库内已含 keystore（debug 用途，密码公开）；缺失时现场生成保证可构建
  keytool -genkeypair -keystore "$KS" -alias fabula -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass fabula123 -keypass fabula123 -dname "CN=Fabula, OU=Board, O=Fabula, C=CN"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:fabula123 --key-pass pass:fabula123 \
  --out "$OUT/Fabula-Board.apk" "$WORK/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/Fabula-Board.apk" | head -4
ls -la "$OUT/Fabula-Board.apk"
