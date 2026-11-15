# Generates plugin/icon.png (512x512) for the PlayStation floating orb.
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

$tile = New-RoundedPath 0 0 511 511 112
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point(0, 511)),
  [System.Drawing.Color]::FromArgb(255, 19, 31, 52),
  [System.Drawing.Color]::FromArgb(255, 4, 7, 13))
$g.FillPath($bg, $tile)

# halo
$haloPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$haloPath.AddEllipse(58, 52, 396, 396)
$halo = New-Object System.Drawing.Drawing2D.PathGradientBrush($haloPath)
$halo.CenterColor = [System.Drawing.Color]::FromArgb(90, 91, 157, 255)
$halo.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 91, 157, 255))
$g.FillPath($halo, $haloPath)

# orb body
$orbPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$orbPath.AddEllipse(126, 120, 260, 260)
$orb = New-Object System.Drawing.Drawing2D.PathGradientBrush($orbPath)
$orb.CenterColor = [System.Drawing.Color]::FromArgb(255, 44, 72, 112)
$orb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 5, 9, 16))
$g.FillPath($orb, $orbPath)

# top shine
$shinePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$shinePath.AddEllipse(166, 146, 180, 120)
$shine = New-Object System.Drawing.Drawing2D.PathGradientBrush($shinePath)
$shine.CenterColor = [System.Drawing.Color]::FromArgb(46, 210, 232, 255)
$shine.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 210, 232, 255))
$g.FillPath($shine, $shinePath)

# rim
$rimPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(90, 170, 208, 255), [single]3)
$g.DrawEllipse($rimPen, 126, 120, 260, 260)

# blue arc
$arcPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 91, 157, 255), [single]12)
$arcPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$arcPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawArc($arcPen, 100, 94, 312, 312, 202, 208)

# PS face buttons
$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 241, 248, 255), [single]10)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

$left = 216
$right = 296
$top = 196
$bottom = 276
$r = 28

$tri = New-Object System.Drawing.Drawing2D.GraphicsPath
$tri.AddPolygon(@(
  (New-Object System.Drawing.PointF($left, ($top - $r))),
  (New-Object System.Drawing.PointF(($left + $r * 0.92), ($top + $r * 0.78))),
  (New-Object System.Drawing.PointF(($left - $r * 0.92), ($top + $r * 0.78)))
))
$g.DrawPath($pen, $tri)

$g.DrawEllipse($pen, ($right - $r), ($top - $r), ($r * 2), ($r * 2))

$k = $r * 0.74
$g.DrawLine($pen, ($left - $k), ($bottom - $k), ($left + $k), ($bottom + $k))
$g.DrawLine($pen, ($left + $k), ($bottom - $k), ($left - $k), ($bottom + $k))

$s = $r * 0.8
$sq = New-RoundedPath ($right - $s) ($bottom - $s) ($s * 2) ($s * 2) 10
$g.DrawPath($pen, $sq)

# inner edge
$edge = New-RoundedPath 1.5 1.5 508 508 111
$edgePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(26, 255, 255, 255), [single]2)
$g.DrawPath($edgePen, $edge)

# brand bar
$bar = New-RoundedPath 186 404 140 10 5
$barBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(220, 91, 157, 255))
$g.FillPath($barBrush, $bar)

$g.Dispose()
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'plugin\icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"wrote $out"
