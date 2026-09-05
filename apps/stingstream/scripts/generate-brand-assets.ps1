<#
.SYNOPSIS
  Regenerates StingStream's placeholder app icon / splash / notification assets.

.DESCRIPTION
  A simple, tasteful "SS" monogram — deliberately not a full illustration, per M5's brief
  ("a simple, tasteful wordmark; keep the existing Streamyfin asset pipeline"). Drawn with
  System.Drawing (GDI+, built into Windows) rather than a design tool or an external image
  library, so this reproduces without installing anything. Dan can swap in real artwork later by
  replacing the files this writes and re-running `expo prebuild` — nothing else in the app
  references these images by content, only by path, and the paths are unchanged from upstream
  Streamyfin's own asset pipeline (see docs/APP-RELEASE.md, "Branding").

  Writes, all under apps/stingstream/assets/images/:
    icon.png                 1024x1024, opaque   — the combined icon (web favicon, non-adaptive fallback)
    icon-android-plain.png   1024x1024, alpha    — Android adaptive icon FOREGROUND layer
    icon-android-themed.png  1024x1024, alpha    — Android 13+ monochrome themed icon (pure white)
    icon-ios-plain.png       1024x1024, alpha    — the splash-screen logo (shared across platforms;
                                                    iOS itself is out of scope, but Android's splash
                                                    reuses this same file per app.json)
    notification.png         96x96,   alpha      — Android status-bar notification icon (pure white
                                                    silhouette; Android tints it, see app.json's
                                                    expo-notifications "color")

  Android's adaptive-icon "safe zone" is roughly the centre 66% of the 1024x1024 canvas — content
  outside it may be cropped by whichever mask shape the launcher applies (circle, squircle, ...).
  Every layer below keeps the monogram within that zone.

.EXAMPLE
  powershell -File apps/stingstream/scripts/generate-brand-assets.ps1
#>

Add-Type -AssemblyName System.Drawing

$assetsDir = Join-Path $PSScriptRoot "..\assets\images"
$assetsDir = (Resolve-Path $assetsDir).Path

# StingStream's brand purple (matches the app's existing accent, e.g. expo-notifications' own
# "color": "#9333EA" in app.json) over a near-black ground, consistent with the app's dark
# userInterfaceStyle and the web manifest's existing "#010101" theme/background color.
$bgDark = [System.Drawing.Color]::FromArgb(255, 8, 6, 14)
$purpleDark = [System.Drawing.Color]::FromArgb(255, 88, 28, 165)   # purple-800
$purpleLight = [System.Drawing.Color]::FromArgb(255, 168, 85, 247) # purple-400
$white = [System.Drawing.Color]::White

function New-Canvas([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    return @{ Bitmap = $bmp; Graphics = $g }
}

function Draw-Monogram($g, [System.Drawing.RectangleF]$bounds, [System.Drawing.Brush]$brush, [double]$scale = 0.62) {
    # "SS" — bold, centred, sized as a fraction of the safe-zone bounds. GDI+'s own text-measurement
    # is used to centre it exactly rather than eyeballing an offset, so this holds up if the font
    # substitutes on a machine without Segoe UI (falls back to a generic bold sans-serif).
    $fontSize = [float]($bounds.Height * $scale)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString("SS", $font, $brush, $bounds, $format)
    $font.Dispose()
    $format.Dispose()
}

function Save-Png($canvas, [string]$path) {
    $canvas.Graphics.Dispose()
    $canvas.Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Bitmap.Dispose()
    Write-Output "wrote $path"
}

# --- icon.png: combined, opaque, full-bleed -----------------------------------------------------
$size = 1024
$c = New-Canvas $size
$bgBrush = New-Object System.Drawing.SolidBrush($bgDark)
$c.Graphics.FillRectangle($bgBrush, 0, 0, $size, $size)
$gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    $purpleLight, $purpleDark)
$safeZone = New-Object System.Drawing.RectangleF(($size * 0.17), ($size * 0.17), ($size * 0.66), ($size * 0.66))
Draw-Monogram $c.Graphics $safeZone $gradBrush
$gradBrush.Dispose()
$bgBrush.Dispose()
Save-Png $c (Join-Path $assetsDir "icon.png")

# --- icon-android-plain.png: adaptive FOREGROUND, transparent, safe zone only --------------------
$c = New-Canvas $size
$gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    $purpleLight, $purpleDark)
$safeZone = New-Object System.Drawing.RectangleF(($size * 0.17), ($size * 0.17), ($size * 0.66), ($size * 0.66))
Draw-Monogram $c.Graphics $safeZone $gradBrush
$gradBrush.Dispose()
Save-Png $c (Join-Path $assetsDir "icon-android-plain.png")

# --- icon-android-themed.png: Android 13+ monochrome, pure white, transparent --------------------
$c = New-Canvas $size
$whiteBrush = New-Object System.Drawing.SolidBrush($white)
$safeZone = New-Object System.Drawing.RectangleF(($size * 0.17), ($size * 0.17), ($size * 0.66), ($size * 0.66))
Draw-Monogram $c.Graphics $safeZone $whiteBrush
$whiteBrush.Dispose()
Save-Png $c (Join-Path $assetsDir "icon-android-themed.png")

# --- icon-ios-plain.png: the splash-screen logo, transparent, centred, more generous margin ------
# expo-splash-screen renders this at imageWidth 100 (points) against the splash's own dark
# background — the file just needs to be a clean transparent-background mark, not full-bleed.
$c = New-Canvas $size
$gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    $purpleLight, $purpleDark)
$splashZone = New-Object System.Drawing.RectangleF(($size * 0.2), ($size * 0.2), ($size * 0.6), ($size * 0.6))
Draw-Monogram $c.Graphics $splashZone $gradBrush
$gradBrush.Dispose()
Save-Png $c (Join-Path $assetsDir "icon-ios-plain.png")

# --- notification.png: 96x96, pure white silhouette, transparent ---------------------------------
# Android tints this at runtime (expo-notifications' "color": "#9333EA" in app.json) and requires
# a genuinely simple, mostly-solid glyph — a single "S" reads far better at 24dp in the status bar
# than a two-letter monogram would.
$nSize = 96
$c = New-Canvas $nSize
$whiteBrush = New-Object System.Drawing.SolidBrush($white)
$fontSize = [float]($nSize * 0.72)
$font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$bounds = New-Object System.Drawing.RectangleF(0, 0, $nSize, $nSize)
$c.Graphics.DrawString("S", $font, $whiteBrush, $bounds, $format)
$font.Dispose()
$format.Dispose()
$whiteBrush.Dispose()
Save-Png $c (Join-Path $assetsDir "notification.png")

Write-Output "Done. Re-run 'expo prebuild --clean' (or the release build script, which does it for you) to pick these up."
