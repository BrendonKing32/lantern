param(
  [Parameter(Mandatory = $true)]
  [string]$BackupId
)

$ErrorActionPreference = "Stop"

if ($BackupId -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$') {
  throw "BackupId must be a timestamp copied from a Lantern backup directory."
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) "lantern-restore-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $temp | Out-Null

try {
  $listFile = Join-Path $temp "r2-objects.json"
  & npx wrangler r2 object get "lantern-backups/backups/$BackupId/r2-objects.json" --remote --file $listFile
  if ($LASTEXITCODE -ne 0) { throw "Could not download the backup object list." }

  $keys = Get-Content -Raw -Path $listFile | ConvertFrom-Json
  foreach ($key in $keys) {
    if ($key -notmatch '^projects/[^/]+/chapters/[^/]+(?:/history/[^/]+)?\.md$') {
      throw "Backup contains an unexpected R2 key: $key"
    }

    $file = Join-Path $temp ([string]$key -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $parent = Split-Path -Parent $file
    New-Item -ItemType Directory -Force -Path $parent | Out-Null

    & npx wrangler r2 object get "lantern-backups/backups/$BackupId/r2/$key" --remote --file $file
    if ($LASTEXITCODE -ne 0) { throw "Could not download backup object: $key" }

    & npx wrangler r2 object put "lantern-manuscripts/$key" --remote --file $file --content-type "text/markdown; charset=utf-8"
    if ($LASTEXITCODE -ne 0) { throw "Could not restore object: $key" }
  }
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force
}
