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

# Otsu 自适应二值化：逐像素处理放进编译好的 C#，比 PowerShell 循环快两个数量级。
# 半透明对话框后面的立绘和背景会把 Windows OCR 带偏，先二值化把文字剥出来。
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace PsOrb {
  public static class Binarizer {
    public static Bitmap Run(Bitmap src, double scale) {
      int w = Math.Max(8, (int)Math.Round(src.Width * scale));
      int h = Math.Max(8, (int)Math.Round(src.Height * scale));
      Bitmap up = new Bitmap(w, h, PixelFormat.Format24bppRgb);
      using (Graphics g = Graphics.FromImage(up)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.Clear(Color.Black);
        g.DrawImage(src, 0, 0, w, h);
      }
      BitmapData data = up.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format24bppRgb);
      try {
        int stride = data.Stride;
        int bytes = stride * h;
        byte[] buf = new byte[bytes];
        Marshal.Copy(data.Scan0, buf, 0, bytes);
        int[] hist = new int[256];
        byte[] gray = new byte[w * h];
        long sum = 0;
        for (int y = 0; y < h; y++) {
          int row = y * stride;
          for (int x = 0; x < w; x++) {
            int i = row + x * 3;
            int v = (buf[i] * 29 + buf[i + 1] * 150 + buf[i + 2] * 77) >> 8;
            gray[y * w + x] = (byte)v;
            hist[v]++;
            sum += v;
          }
        }
        long total = (long)w * h;
        long sumB = 0;
        long wB = 0;
        double maxVar = -1.0;
        int thr = 128;
        for (int t = 0; t < 256; t++) {
          wB += hist[t];
          if (wB == 0) continue;
          long wF = total - wB;
          if (wF == 0) break;
          sumB += (long)t * hist[t];
          double mB = (double)sumB / wB;
          double mF = (double)(sum - sumB) / wF;
          double v = (double)wB * wF * (mB - mF) * (mB - mF);
          if (v > maxVar) { maxVar = v; thr = t; }
        }
        // 白字黑底是 VN 的常态：阈值略抬高，把描边留在黑色一侧
        int cut = Math.Min(250, thr + 18);
        for (int i = 0; i < gray.Length; i++) {
          byte val = gray[i] >= cut ? (byte)255 : (byte)0;
          int j = (i / w) * stride + (i % w) * 3;
          buf[j] = val;
          buf[j + 1] = val;
          buf[j + 2] = val;
        }
        Marshal.Copy(buf, 0, data.Scan0, bytes);
      } finally {
        up.UnlockBits(data);
      }
      return up;
    }
  }
}
"@

# 识别进程降为低于正常优先级：OCR 的那一下不会和游戏抢 CPU，鼠标就不会顿
try {
  [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
} catch {
  # 设置失败不影响识别
}

# 从画面里挑一个好看的主色给字幕条用：只取饱和度高、明度适中的像素求平均，
# 再把结果压进固定的饱和度/明度区间，避免采样到大片肤色或暗背景后字幕变得脏。
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace PsOrb {
  public static class Accent {
    public static string FromBitmap(Bitmap bmp) {
      if (bmp == null) return "";
      Bitmap src = bmp;
      bool owned = false;
      // 抓屏得到的是 32bpp，LockBits 必须按实际格式来，所以先统一转成 24bpp
      if (Image.GetPixelFormatSize(bmp.PixelFormat) != 24) {
        src = new Bitmap(bmp.Width, bmp.Height, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(src)) {
          g.DrawImage(bmp, 0, 0, bmp.Width, bmp.Height);
        }
        owned = true;
      }
      BitmapData data = src.LockBits(new Rectangle(0, 0, src.Width, src.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      double sumR = 0, sumG = 0, sumB = 0, weight = 0;
      try {
        int stride = data.Stride;
        int bytes = stride * src.Height;
        byte[] buf = new byte[bytes];
        Marshal.Copy(data.Scan0, buf, 0, bytes);
        int step = src.Width > 200 ? 4 : 2;
        for (int y = 0; y < src.Height; y += step) {
          int row = y * stride;
          for (int x = 0; x < src.Width; x += step) {
            int i = row + x * 3;
            double b = buf[i], g = buf[i + 1], r = buf[i + 2];
            double max = Math.Max(r, Math.Max(g, b));
            double min = Math.Min(r, Math.Min(g, b));
            if (max < 50 || max > 245) continue;
            double s = max <= 0 ? 0 : (max - min) / max;
            double v = max / 255.0;
            if (s < 0.35 || v < 0.25 || v > 0.92) continue;
            double w = s * (1.0 - Math.Abs(v - 0.6));
            sumR += r * w; sumG += g * w; sumB += b * w; weight += w;
          }
        }
      } finally {
        src.UnlockBits(data);
        if (owned) src.Dispose();
      }
      if (weight <= 0) return "";
      double ar = sumR / weight, ag = sumG / weight, ab = sumB / weight;
      double h, sat, light;
      ToHsl(ar, ag, ab, out h, out sat, out light);
      // 固定观感：饱和度 62%，明度 62%，色相跟随画面
      return FromHsl(h, 0.62, 0.62);
    }

    static void ToHsl(double r, double g, double b, out double h, out double s, out double l) {
      r /= 255; g /= 255; b /= 255;
      double max = Math.Max(r, Math.Max(g, b));
      double min = Math.Min(r, Math.Min(g, b));
      l = (max + min) / 2;
      if (max == min) { h = 0; s = 0; return; }
      double d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max == r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max == g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }

    static string FromHsl(double h, double s, double l) {
      double r, g, b;
      if (s == 0) { r = g = b = l; }
      else {
        double q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        double p = 2 * l - q;
        r = Hue(p, q, h + 1.0 / 3);
        g = Hue(p, q, h);
        b = Hue(p, q, h - 1.0 / 3);
      }
      return string.Format("#{0:x2}{1:x2}{2:x2}", (int)Math.Round(r * 255), (int)Math.Round(g * 255), (int)Math.Round(b * 255));
    }

    static double Hue(double p, double q, double t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1.0 / 6) return p + (q - p) * 6 * t;
      if (t < 1.0 / 2) return q;
      if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
      return p;
    }
  }
}
"@

# 前台窗口：游戏被别的窗口盖住时不要再抓屏 —— 抓到的会是聊天窗/桌面，
# 既白烧 OCR 也把垃圾文字送进翻译。只判断框选区域的中心点是否落在前台窗口内。
Add-Type -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@ -Name 'Fg' -Namespace 'PsOrb'

function Test-ForegroundCovers([int]$x, [int]$y, [int]$w, [int]$h) {
  try {
    $hwnd = [PsOrb.Fg]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return $true }
    # 前台可能是输入法候选框、浮动提示这类小弹窗，先上溯到最外层所属窗口再判断
    $root = [PsOrb.Fg]::GetAncestor($hwnd, 3)
    if ($root -ne [IntPtr]::Zero) { $hwnd = $root }
    $rect = New-Object 'PsOrb.Fg+RECT'
    if (-not [PsOrb.Fg]::GetWindowRect($hwnd, [ref]$rect)) { return $true }
    if ($rect.Right -le $rect.Left -or $rect.Bottom -le $rect.Top) { return $true }
    $cx = $x + [int]($w / 2)
    $cy = $y + [int]($h / 2)
    return ($cx -ge $rect.Left -and $cx -le $rect.Right -and $cy -ge $rect.Top -and $cy -le $rect.Bottom)
  } catch {
    # 判断失败就当没被遮挡，宁可多识别一次也不要漏台词
    return $true
  }
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

$SAMPLE_STEP = 8
$DIFF_THRESHOLD = 0.004
$lastSamples = $null
$prevSamples = $null
$skipCount = 0
$waitCount = 0

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
  # Windows OCR 对小字很吃力：框得很矮时至少把高度放大到 40px（LunaTranslator 的同款做法）
  $minHeightScale = 40.0 / [Math]::Max(1, $bmp.Height)
  if ($minHeightScale -gt $scale -and $minHeightScale -le 4.0) { $scale = $minHeightScale }
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

# 第二套预处理：2 倍放大 + Otsu 自适应二值化。
# VN 的对话框是半透明的，台词后面就是立绘和背景，Windows OCR 会被这些杂色带偏；
# 二值化把文字从背景里剥出来后，同一句台词从乱码变成几乎全对（实测只剩一个促音之差）。
function Get-OcrBitmapEnhanced($bmp) {
  $area = [double]$bmp.Width * [double]$bmp.Height
  $scale = 2.0
  if ($area -gt 0) { $scale = [Math]::Min(2.5, [Math]::Sqrt(2400000 / $area)) }
  if ($scale -lt 1.2) { $scale = 1.2 }
  return [PsOrb.Binarizer]::Run($bmp, $scale)
}

# 位图 → BMP 内存流 → 识别；-Enhanced 走二值化那一套
function Get-Lines-From-Bitmap($bmp, [switch]$Enhanced) {
  if ($Enhanced) {
    $ocrBmp = Get-OcrBitmapEnhanced $bmp
  } else {
    $ocrBmp = Get-OcrBitmap $bmp
  }
  $ms = New-Object System.IO.MemoryStream
  $stream = $null
  try {
    $ocrBmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $ms.Position = 0
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    return (Get-Lines $stream)
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
    $right = [double]::MinValue
    foreach ($word in $line.Words) {
      $rect = $word.BoundingRect
      if ($rect.Top -lt $top) { $top = $rect.Top }
      if ($rect.Left -lt $left) { $left = $rect.Left }
      if ($rect.Bottom -gt $bottom) { $bottom = $rect.Bottom }
      if ($rect.Right -gt $right) { $right = $rect.Right }
    }
    if ($top -eq [double]::MaxValue) { $top = 0; $left = 0; $bottom = 1; $right = 1 }
    $items += [pscustomobject]@{ Text = $t; Top = $top; Left = $left; Bottom = $bottom; Right = $right }
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
      $target.Left = [Math]::Min($target.Left, $item.Left)
      $target.Right = [Math]::Max($target.Right, $item.Right)
      $target.Height = [Math]::Max(1, $target.Bottom - $target.Top)
    } else {
      $rows += [pscustomobject]@{
        Top = $item.Top
        Bottom = $item.Bottom
        Left = $item.Left
        Right = $item.Right
        Height = $height
        Items = @($item)
      }
    }
  }
  $lines = @()
  $blocks = @()
  $previous = $null
  foreach ($row in ($rows | Sort-Object Top)) {
    $text = (($row.Items | Sort-Object Left | ForEach-Object { $_.Text }) -join '')
    if ($text -eq '') { continue }
    $lines += $text
    # 沿用 LunaTranslator 的拼接规则：上一行右端没有延伸到本行右端附近，
    # 说明是另一个文本框（旁白/名字框），要断行；否则是同段文字的自动换行，直接接上。
    if ($blocks.Count -gt 0 -and $null -ne $previous -and $previous.Right -ge ($row.Right - $row.Height)) {
      $blocks[$blocks.Count - 1] = $blocks[$blocks.Count - 1] + $text
    } else {
      $blocks += $text
    }
    $previous = $row
  }
  return @{ Lines = $lines; Blocks = $blocks }
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

# 画面指纹比对：ok / skip / wait / black。
# 借鉴 LunaTranslator 的「等画面稳定再识别」：字幕逐字显示、立绘切换、特效播放时
# 抓到的是中间态，识别出来必然缺字错字，所以和上一帧还在明显变化时先不识别。
function Test-FrameChange($bmp) {
  $signature = Get-Signature $bmp
  $max = 0
  foreach ($v in $signature) { if ($v -gt $max) { $max = $v } }
  # 独占全屏 / 受保护画面会抓成纯黑，交给主进程回落到系统截图
  if ($max -lt 24) { return 'black' }
  $diffStable = Compare-Signature $script:lastSamples $signature
  $diffPrevious = Compare-Signature $script:prevSamples $signature
  $hadPrevious = $null -ne $script:prevSamples
  $script:prevSamples = $signature
  if ($diffStable -lt 0.0012) {
    # 和上次识别过的画面一样：直接跳过
    $script:skipCount = 0
    return 'skip'
  }
  # 连续变化时最多等 6 帧（约 3.6 秒），避免动态背景导致永远不识别
  if ($hadPrevious -and $diffPrevious -gt 0.004 -and $script:waitCount -lt 6) {
    $script:waitCount += 1
    return 'wait'
  }
  $script:waitCount = 0
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
    if ($line.StartsWith('capimg ') -or $line.StartsWith('capimgfg ')) {
      # 只抓图不识别：画面稳定时存成 BMP，交给主进程的 PaddleOCR 子进程。
      # 画面指纹和等稳定帧的逻辑仍然留在这里，避免对没变化的帧跑一遍模型。
      # capimgfg 额外要求游戏窗口在前台，被别的窗口盖住时直接跳过。
      $fgOnly = $line.StartsWith('capimgfg ')
      $payload = if ($fgOnly) { $line.Substring(9) } else { $line.Substring(7) }
      $cap = ConvertTo-CaptureArgs ($payload.Trim() -split '\s+')
      if (-not $cap) { Write-Line '{"error":"bad-capture-args"}'; continue }
      if ($fgOnly -and -not (Test-ForegroundCovers $cap.X $cap.Y $cap.W $cap.H)) {
        Write-Line '{"skip":"fg"}'
        continue
      }
      $bmp = Get-CaptureBitmap $cap.X $cap.Y $cap.W $cap.H $cap.Masks
      try {
        $state = Test-FrameChange $bmp
        if ($state -eq 'black') { Write-Line '{"error":"capture-black"}'; continue }
        if ($state -eq 'skip') { Write-Line '{"skip":true}'; continue }
        if ($state -eq 'wait') { Write-Line '{"wait":true}'; continue }
        $imgPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'local-vnite-ps-orb-frame.bmp')
        $bmp.Save($imgPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
        $result = @{ img = $imgPath }
        try {
          $accent = [PsOrb.Accent]::FromBitmap($bmp)
          if ($accent) { $result.accent = $accent }
        } catch {
          # 取色失败不影响识别
        }
        Write-Line ($result | ConvertTo-Json -Compress)
      } finally {
        $bmp.Dispose()
      }
    } elseif ($line.StartsWith('cap ')) {
      $cap = ConvertTo-CaptureArgs (($line.Substring(4).Trim()) -split '\s+')
      if (-not $cap) { Write-Line '{"error":"bad-capture-args"}'; continue }
      $bmp = Get-CaptureBitmap $cap.X $cap.Y $cap.W $cap.H $cap.Masks
      try {
        $state = Test-FrameChange $bmp
        if ($state -eq 'black') { Write-Line '{"error":"capture-black"}'; continue }
        if ($state -eq 'skip') { Write-Line '{"skip":true}'; continue }
        if ($state -eq 'wait') { Write-Line '{"wait":true}'; continue }
        $first = Get-Lines-From-Bitmap $bmp -Enhanced
        $lines = @($first.Lines)
        $blocks = @($first.Blocks)
        # 二值化结果为空或混进半角字母/数字（认错假名的典型征兆）时，再用原图复核一次。
        # 正常日文台词不跑第二遍，避免长文本识别时间翻倍。
        $joined = ($lines -join '')
        $alt = @()
        $altBlocks = @()
        if ($joined.Trim() -eq '' -or $joined -match '[A-Za-z0-9]') {
          try {
            $second = Get-Lines-From-Bitmap $bmp
            $alt = @($second.Lines)
            $altBlocks = @($second.Blocks)
          } catch {
            $alt = @()
            $altBlocks = @()
          }
        }
        Write-Line (@{
          text = ($blocks -join "`n")
          lines = $lines
          blocks = $blocks
          alt = $alt
          altBlocks = $altBlocks
        } | ConvertTo-Json -Compress -Depth 3)
      } finally {
        $bmp.Dispose()
      }
    } else {
      $bmp = $null
      try {
        $bmp = [System.Drawing.Bitmap]::FromFile($line)
        $first = Get-Lines-From-Bitmap $bmp -Enhanced
        $lines = @($first.Lines)
        $blocks = @($first.Blocks)
        $joined = ($lines -join '')
        $alt = @()
        $altBlocks = @()
        if ($joined.Trim() -eq '' -or $joined -match '[A-Za-z0-9]') {
          try {
            $second = Get-Lines-From-Bitmap $bmp
            $alt = @($second.Lines)
            $altBlocks = @($second.Blocks)
          } catch {
            $alt = @()
            $altBlocks = @()
          }
        }
        Write-Line (@{
          text = ($blocks -join "`n")
          lines = $lines
          blocks = $blocks
          alt = $alt
          altBlocks = $altBlocks
        } | ConvertTo-Json -Compress -Depth 3)
      } finally {
        if ($bmp) { $bmp.Dispose() }
      }
    }
  } catch {
    $msg = $_.Exception.Message -replace '"', "'" -replace "`r", ' ' -replace "`n", ' '
    Write-Line ('{"error":"' + $msg + '"}')
  }
}
