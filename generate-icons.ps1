$src = Join-Path (Get-Location) 'logo.png'
$sizes = @(72, 96, 128, 192, 256, 384, 512)
$outDir = Join-Path (Get-Location) 'public\icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($img, 0, 0, $size, $size)
    $path = Join-Path $outDir "icon-$size.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}
$img.Dispose()
Write-Output 'Icons generated.'
