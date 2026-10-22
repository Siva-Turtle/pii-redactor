# Downloads the GLiNER onnx weights (183 MB, not committed: over GitHub's
# 100 MB file limit). PowerShell 5+ and 7. Skips the download when the file
# is already present with the right SHA-256; verifies the checksum afterwards
# and fails loudly otherwise. No npm needed.
$ErrorActionPreference = 'Stop'
$Dest = Join-Path $PSScriptRoot '..\vendor\gliner\models\onnx-community\gliner_small-v2.1\onnx\model_quantized.onnx'
$Url = 'https://huggingface.co/onnx-community/gliner_small-v2.1/resolve/main/onnx/model_quantized.onnx'
$Sha = 'c76c90920547fd937aaf505e7f2de5ec73168bf1c25abbb55a298104cb061400'

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower()
}

if (Test-Path -LiteralPath $Dest -PathType Leaf) {
  if ((Get-Sha256 $Dest) -eq $Sha) {
    Write-Host "OK: $Dest already present with the expected SHA-256."
    exit 0
  }
  Write-Warning "SHA-256 mismatch on existing $Dest; re-downloading…"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dest) | Out-Null
# WHY .tmp + rename: a half-downloaded file must never look complete.
$Tmp = "$Dest.tmp"
Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing
Move-Item -Force -LiteralPath $Tmp -Destination $Dest
$Got = Get-Sha256 $Dest
Write-Host "SHA-256: $Got  $Dest"
Write-Host "expect: $Sha"
if ($Got -ne $Sha) {
  Write-Error "ERROR: SHA-256 mismatch for $Dest (downloaded file kept for inspection)."
  exit 1
}
Write-Host "OK: $Dest downloaded and verified."
