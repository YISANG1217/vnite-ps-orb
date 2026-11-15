param([string]$Lang = 'ja')

# 常驻的 Windows OCR 助手：从 stdin 逐行读取命令，输出一行 JSON。
#   cap <x> <y> <w> <h>   直接抓取屏幕区域并识别（物理像素坐标，GDI 截图）
#   <图片路径>            识别已有图片（系统截图回落路径）
# 截图放在子进程里做：主进程不再周期性抓全屏、不写临时文件，鼠标才不会隔几秒卡一下。
# 注意：必须自己写 UTF-8 字节，PowerShell 5.1 直接 Write-Output 会变成 UTF-16。

function Write-Line([string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text + "`n")
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
# 让 GDI 截图走物理像素坐标，避免高 DPI 下画面被系统二次缩放变模糊
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name 'Dpi' -Namespace 'PsOrb'
[PsOrb.Dpi]::SetProcessDPIAware() | Out-Null

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($task, $type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $netTask = $asTask.Invoke($null, @($task))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) {
  Write-Line '{"error":"no-ocr-engine"}'
  exit 1
}

$SAMPLE_STEP = 16
$DIFF_THRESHOLD = 0.02
$lastSamples = $null

# 按 16px 网格采样整块区域，得到一个很轻的画面指纹
function Get-Signature($bmp) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $stride = $data.Stride
    $length = $stride * $bmp.Height
    $bytes = New-Object byte[] $length
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $length)
  } finally {
    $bmp.UnlockBits($data)
  }
  $values = New-Object 'System.Collections.Generic.List[int]'
  for ($y = 0; $y -lt $bmp.Height; $y += $SAMPLE_STEP) {
    $row = $y * $stride
    for ($x = 0; $x -lt $bmp.Width; $x += $SAMPLE_STEP) {
      $i = $row + $x * 4
      $values.Add([int]$bytes[$i] + [int]$bytes[$i + 1] + [int]$bytes[$i + 2])
    }
  }
  return ,$values.ToArray()
}

function Compare-Signature($a, $b) {
  if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length) { return 1.0 }
  $changed = 0
  for ($i = 0; $i -lt $a.Length; $i++) {
    if ([Math]::Abs($a[$i] - $b[$i]) -gt 60) { $changed++ }
  }
  return [double]$changed / $a.Length
}

function Get-Lines($stream) {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied
  )) ([Windows.Graphics.Imaging.SoftwareBitmap])
  try {
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    $bitmap.Dispose()
  }
  $lines = @()
  foreach ($line in $result.Lines) {
    $t = $line.Text.Trim()
    if ($t -ne '') { $lines += $t }
  }
  return ,$lines
}

function ConvertTo-Json-Lines($lines) {
  return (@{ text = (@($lines) -join "`n"); lines = @($lines) } | ConvertTo-Json -Compress -Depth 3)
}

Write-Line '{"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    if ($line.StartsWith('cap ')) {
      $parts = ($line.Substring(4).Trim()) -split '\s+'
      if ($parts.Count -ne 4) { Write-Line '{"error":"bad-capture-args"}'; continue }
      $cx = [int]$parts[0]
      $cy = [int]$parts[1]
      $cw = [int]$parts[2]
      $ch = [int]$parts[3]
      if ($cw -lt 8 -or $ch -lt 8) { Write-Line '{"error":"bad-capture-args"}'; continue }

      $bmp = New-Object System.Drawing.Bitmap($cw, $ch, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
          $g.CopyFromScreen($cx, $cy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)), [System.Drawing.CopyPixelOperation]::SourceCopy)
        } finally {
          $g.Dispose()
        }

        $signature = Get-Signature $bmp
        $max = 0
        foreach ($v in $signature) { if ($v -gt $max) { $max = $v } }
        # 独占全屏 / 受保护画面会抓成纯黑，交给主进程回落到系统截图
        if ($max -lt 24) { Write-Line '{"error":"capture-black"}'; continue }

        if ((Compare-Signature $lastSamples $signature) -lt $DIFF_THRESHOLD) {
          # 画面几乎没变：不更新基准，让缓慢变化继续累积，也省掉一次 OCR
          Write-Line '{"skip":true}'
          continue
        }
        $lastSamples = $signature

        $ms = New-Object System.IO.MemoryStream
        $stream = $null
        try {
          $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
          $ms.Position = 0
          $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
          $lines = Get-Lines $stream
          Write-Line (ConvertTo-Json-Lines $lines)
        } finally {
          if ($stream) { $stream.Dispose() }
          $ms.Dispose()
        }
      } finally {
        $bmp.Dispose()
      }
    } else {
      $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($line)) ([Windows.Storage.StorageFile])
      $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      try {
        $lines = Get-Lines $stream
        Write-Line (ConvertTo-Json-Lines $lines)
      } finally {
        $stream.Dispose()
      }
    }
  } catch {
    $msg = $_.Exception.Message -replace '"', "'" -replace "`r", ' ' -replace "`n", ' '
    Write-Line ('{"error":"' + $msg + '"}')
  }
}
