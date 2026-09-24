# Fabula Board APK builder (no Gradle: aapt2 + javac + d8 + zipalign + apksigner)
# Requires: I:\AndroidTools\jdk-17.0.2 and I:\AndroidTools\sdk (platforms;android-34, build-tools;34.0.0)
# Output:   android\build\Fabula-Board.apk (debug-signed, installable)
# NOTE: keep this file ASCII-only - PowerShell 5.1 reads scripts as ANSI/GBK,
#       non-ASCII comments corrupt quote pairing (learned the hard way).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = 'I:\AndroidTools'
$jdk = "$tools\jdk-17.0.2"
$bt = "$tools\sdk\build-tools\34.0.0"
$plat = "$tools\sdk\platforms\android-34\android.jar"
$env:JAVA_HOME = $jdk
$env:PATH = "$jdk\bin;$env:PATH"

$out = "$here\build"
$work = "$here\.work"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out, $work, "$work\gen", "$work\classes", "$work\dex" | Out-Null

Write-Host '1/7 icons (node tools/make-icon.mjs -> build/ + android res)'
Push-Location "$here\.."
& node tools\make-icon.mjs
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'make-icon failed' }
Pop-Location

Write-Host '2/7 aapt2 compile'
& "$bt\aapt2.exe" compile --dir "$here\res" -o "$work\res.zip"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Host '3/7 aapt2 link'
& "$bt\aapt2.exe" link -o "$work\base.apk" -I $plat --manifest "$here\AndroidManifest.xml" -R "$work\res.zip" --java "$work\gen" --min-sdk-version 24 --target-sdk-version 34
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Host '4/7 javac'
$srcs = @(Get-ChildItem "$here\src", "$work\gen" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
& "$jdk\bin\javac.exe" --release 11 -encoding UTF-8 -Xlint:none -classpath $plat -d "$work\classes" $srcs
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Host '5/7 d8'
$classes = @(Get-ChildItem "$work\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName })
& "$bt\d8.bat" --lib $plat --min-api 24 --output "$work\dex" $classes
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Write-Host '6/7 pack dex + zipalign'
Copy-Item "$work\base.apk" "$work\unsigned.apk" -Force
& "$jdk\bin\jar.exe" --update --file "$work\unsigned.apk" -C "$work\dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw 'jar add dex failed' }
& "$bt\zipalign.exe" -f -p 4 "$work\unsigned.apk" "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Write-Host '7/7 sign'
$ks = "$here\debug.keystore"
if (-not (Test-Path $ks)) {
  & "$jdk\bin\keytool.exe" -genkeypair -v -keystore $ks -alias fabula -keyalg RSA -keysize 2048 -validity 10000 -storepass fabula123 -keypass fabula123 -dname "CN=Fabula, OU=Board, O=Fabula, C=CN" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:fabula123 --key-pass pass:fabula123 --out "$out\Fabula-Board.apk" "$work\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

Write-Host '--- verify:'
& "$bt\apksigner.bat" verify --print-certs "$out\Fabula-Board.apk" | Select-Object -First 4
Get-Item "$out\Fabula-Board.apk" | ForEach-Object { Write-Host ("APK => " + $_.FullName + "  (" + [math]::Round($_.Length / 1KB, 1) + " KB)") }
