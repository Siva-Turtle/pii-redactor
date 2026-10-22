# Downloads the GLiNER onnx weights (83 MB, not committed: keeps the repo
# light). PowerShell 5+ and 7. Skips the download when the file is already
# present with the right SHA-256; verifies the checksum afterwards and fails
# loudly otherwise. No npm needed.
$ErrorActionPreference = 'Stop'
# WHY SilentlyContinue: Windows PowerShell 5's progress bar makes Invoke-WebRequest very slow.
$ProgressPreference = 'SilentlyContinue'
$Dest = Join-Path $PSScriptRoot '..\vendor\gliner\models\knowledgator\gliner-pii-small-v1.0\onnx\model_quint8.onnx'
$Url = 'https://huggingface.co/knowledgator/gliner-pii-small-v1.0/resolve/main/onnx/model_quint8.onnx'
$Sha = '891589426ee96f2748b16439f44fad8c3f97e198e002a6637e58dee989500216'

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
