param([string]$Lang = 'ja')

# 常驻的 Windows OCR 助手：从 stdin 逐行读取命令，输出一行 JSON。
#   cap <x> <y> <w> <h>   直接抓取屏幕区域并识别（物理像素坐标，GDI 截图）
#   grab "<png路径>" <x> <y> <w> <h>
#                          只抓图不识别，存成 PNG 并返回 {file,width,height}（给 PaddleOCR 用）
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

# 识别进程降为低于正常优先级：OCR 的那一下不会和游戏抢 CPU，鼠标就不会顿
try {
  [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
} catch {
  # 设置失败不影响识别
}

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

$SAMPLE_STEP = 12
$DIFF_THRESHOLD = 0.012
$lastSamples = $null
$skipCount = 0

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

# 识别前放大。像素越多 OCR 越慢，所以按「总像素预算」决定倍率：
# 短句（区域小）用 1.5 倍，长文本自动降到 1.0~1.3 倍，保证大段文字也不会等太久。
function Get-OcrBitmap($bmp) {
  $maxWidth = 2400
  $pixelBudget = 1200000
  $area = [double]$bmp.Width * [double]$bmp.Height
  $scale = 1.5
  if ($area -gt 0) {
    $scale = [Math]::Min(1.5, [Math]::Sqrt($pixelBudget / $area))
  }
  $scale = [Math]::Min($scale, $maxWidth / [Math]::Max(1, $bmp.Width))
  if ($scale -lt 1.0 -and $area -le $pixelBudget) { $scale = 1.0 }
  if ($scale -gt 0.999 -and $scale -lt 1.001) { return $bmp }
  $w = [int][Math]::Max(8, [Math]::Round($bmp.Width * $scale))
  $h = [int][Math]::Max(8, [Math]::Round($bmp.Height * $scale))
  $scaled = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($bmp, 0, 0, $w, $h)
  } finally {
    $g.Dispose()
  }
  return $scaled
}

# 位图 → BMP 内存流 → 识别
function Get-Lines-From-Bitmap($bmp) {
  $ocrBmp = Get-OcrBitmap $bmp
  $ms = New-Object System.IO.MemoryStream
  $stream = $null
  try {
    $ocrBmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $ms.Position = 0
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    return ,(Get-Lines $stream)
  } finally {
    if ($stream) { $stream.Dispose() }
    $ms.Dispose()
    if (-not [object]::ReferenceEquals($ocrBmp, $bmp)) { $ocrBmp.Dispose() }
  }
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
  # OCR 返回的行顺序不保证是从上到下，而且同一行可能被拆成几段。
  # 先按垂直重叠把属于同一视觉行的片段归组，组内按左边界排序，再按上边界排列各组。
  $items = @()
  foreach ($line in $result.Lines) {
    $t = $line.Text.Trim()
    if ($t -eq '') { continue }
    $top = [double]::MaxValue
    $left = [double]::MaxValue
    $bottom = [double]::MinValue
    foreach ($word in $line.Words) {
      $rect = $word.BoundingRect
      if ($rect.Top -lt $top) { $top = $rect.Top }
      if ($rect.Left -lt $left) { $left = $rect.Left }
      if ($rect.Bottom -gt $bottom) { $bottom = $rect.Bottom }
    }
    if ($top -eq [double]::MaxValue) { $top = 0; $left = 0; $bottom = 1 }
    $items += [pscustomobject]@{ Text = $t; Top = $top; Left = $left; Bottom = $bottom }
  }
  $rows = @()
  foreach ($item in ($items | Sort-Object Top)) {
    $height = [Math]::Max(1, $item.Bottom - $item.Top)
    $target = $null
    foreach ($row in $rows) {
      $overlap = [Math]::Min($row.Bottom, $item.Bottom) - [Math]::Max($row.Top, $item.Top)
      if ($overlap -gt 0.5 * [Math]::Min($row.Height, $height)) { $target = $row; break }
    }
    if ($target) {
      $target.Items += $item
      $target.Top = [Math]::Min($target.Top, $item.Top)
      $target.Bottom = [Math]::Max($target.Bottom, $item.Bottom)
      $target.Height = [Math]::Max(1, $target.Bottom - $target.Top)
    } else {
      $rows += [pscustomobject]@{ Top = $item.Top; Bottom = $item.Bottom; Height = $height; Items = @($item) }
    }
  }
  $lines = @()
  foreach ($row in ($rows | Sort-Object Top)) {
    $lines += (($row.Items | Sort-Object Left | ForEach-Object { $_.Text }) -join '')
  }
  return ,$lines
}

function ConvertTo-Json-Lines($lines) {
  return (@{ text = (@($lines) -join "`n"); lines = @($lines) } | ConvertTo-Json -Compress -Depth 3)
}

# 抓取一块屏幕区域（物理像素），$Masks 是 4 个一组的「要涂黑的矩形」，可省略
function Get-CaptureBitmap([int]$cx, [int]$cy, [int]$cw, [int]$ch, $Masks) {
  $bmp = New-Object System.Drawing.Bitmap($cw, $ch, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($cx, $cy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)), [System.Drawing.CopyPixelOperation]::SourceCopy)
      if ($Masks -and $Masks.Count -ge 4) {
        $full = New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)
        for ($i = 0; $i + 3 -lt $Masks.Count; $i += 4) {
          $maskX = [int]$Masks[$i] - $cx
          $maskY = [int]$Masks[$i + 1] - $cy
          $maskR = New-Object System.Drawing.Rectangle($maskX, $maskY, [int]$Masks[$i + 2], [int]$Masks[$i + 3])
          $hit = [System.Drawing.Rectangle]::Intersect($maskR, $full)
          if ($hit.Width -gt 0 -and $hit.Height -gt 0) {
            $g.FillRectangle([System.Drawing.Brushes]::Black, $hit)
          }
        }
      }
    } finally {
      $g.Dispose()
    }
    return $bmp
  } catch {
    $bmp.Dispose()
    throw
  }
}

# 画面指纹比对：ok / skip / black。$lastSamples、$skipCount 属于脚本作用域
function Test-FrameChange($bmp) {
  $signature = Get-Signature $bmp
  $max = 0
  foreach ($v in $signature) { if ($v -gt $max) { $max = $v } }
  # 独占全屏 / 受保护画面会抓成纯黑，交给主进程回落到系统截图
  if ($max -lt 24) { return 'black' }
  $diff = Compare-Signature $script:lastSamples $signature
  if ($diff -lt 0.0008) {
    # 完全没变：直接跳过，不做任何识别
    $script:skipCount = 0
    return 'skip'
  }
  if ($diff -lt $DIFF_THRESHOLD) {
    # 变化太小先跳过，但最多跳两次：再小的变化也强制识别一帧，
    # 否则「翻页后只有一小行字变了」会永远触发不了
    if ($script:skipCount -lt 2) {
      $script:skipCount++
      return 'skip'
    }
  }
  $script:skipCount = 0
  $script:lastSamples = $signature
  return 'ok'
}

# 解析 "x y w h [mask...]" 参数
function ConvertTo-CaptureArgs($parts) {
  if ($parts.Count -lt 4 -or (($parts.Count - 4) % 4) -ne 0) { return $null }
  $result = @{
    X = [int]$parts[0]
    Y = [int]$parts[1]
    W = [int]$parts[2]
    H = [int]$parts[3]
    Masks = @()
  }
  if ($result.W -lt 8 -or $result.H -lt 8) { return $null }
  if ($parts.Count -ge 8) {
    $masks = @()
    for ($i = 4; $i -lt $parts.Count; $i++) { $masks += [int]$parts[$i] }
    $result.Masks = $masks
  }
  return $result
}

Write-Line '{"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    if ($line.StartsWith('cap ')) {
      $cap = ConvertTo-CaptureArgs (($line.Substring(4).Trim()) -split '\s+')
      if (-not $cap) { Write-Line '{"error":"bad-capture-args"}'; continue }
      $bmp = Get-CaptureBitmap $cap.X $cap.Y $cap.W $cap.H $cap.Masks
      try {
        $state = Test-FrameChange $bmp
        if ($state -eq 'black') { Write-Line '{"error":"capture-black"}'; continue }
        if ($state -eq 'skip') { Write-Line '{"skip":true}'; continue }
        $lines = Get-Lines-From-Bitmap $bmp
        Write-Line (ConvertTo-Json-Lines $lines)
      } finally {
        $bmp.Dispose()
      }
    } elseif ($line.StartsWith('grab ')) {
      # grab "<png 路径>" x y w h [mask...]：只抓图不识别，交给主进程的 PaddleOCR。
      # 路径加引号，避免用户名里有空格时参数错位。
      $match = [regex]::Match($line, '^grab\s+"([^"]+)"\s+(.+)$')
      if (-not $match.Success) { Write-Line '{"error":"bad-grab-args"}'; continue }
      $cap = ConvertTo-CaptureArgs ($match.Groups[2].Value.Trim() -split '\s+')
      if (-not $cap) { Write-Line '{"error":"bad-capture-args"}'; continue }
      $target = $match.Groups[1].Value
      $bmp = Get-CaptureBitmap $cap.X $cap.Y $cap.W $cap.H $cap.Masks
      try {
        $state = Test-FrameChange $bmp
        if ($state -eq 'black') { Write-Line '{"error":"capture-black"}'; continue }
        if ($state -eq 'skip') { Write-Line '{"skip":true}'; continue }
        $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Line (@{ file = $target; width = $cap.W; height = $cap.H } | ConvertTo-Json -Compress)
      } finally {
        $bmp.Dispose()
      }
    } else {
      $bmp = $null
      try {
        $bmp = [System.Drawing.Bitmap]::FromFile($line)
        $lines = Get-Lines-From-Bitmap $bmp
        Write-Line (ConvertTo-Json-Lines $lines)
      } finally {
        if ($bmp) { $bmp.Dispose() }
      }
    }
  } catch {
    $msg = $_.Exception.Message -replace '"', "'" -replace "`r", ' ' -replace "`n", ' '
    Write-Line ('{"error":"' + $msg + '"}')
  }
}
