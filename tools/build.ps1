# 打包插件为 Vnite 可安装的 .vnpkg（zip 容器，manifest.json 必须位于根目录）
# 用法：pwsh tools/build.ps1 [-OutDir <目录>]
param([string]$OutDir = '')

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$plugin = Join-Path $root 'plugin'
$manifest = Get-Content (Join-Path $plugin 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$out = if ($OutDir) {
  if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
} else {
  Join-Path $root 'dist'
}
New-Item -ItemType Directory -Force -Path $out | Out-Null

$zip = Join-Path $out "$($manifest.id)-$($manifest.version).vnpkg"
if (Test-Path $zip) { Remove-Item $zip -Force }

# 直接从 plugin/ 目录压包：manifest.json 落在压缩包根目录
# （Compress-Archive 只认 .zip 扩展名，这里用 ZipFile）
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $plugin,
  $zip,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "打包完成：$zip（$size MB）"
