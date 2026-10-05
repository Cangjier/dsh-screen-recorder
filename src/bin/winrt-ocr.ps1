using namespace Windows.Media.Ocr
using namespace Windows.Globalization
using namespace Windows.Graphics.Imaging

# 用 Windows 自带的识别引擎读一张图上的文字，并把结果打成一行 JSON。
#
# 这个脚本存在的意义，是让 dsh-screen-recorder 在不依赖另一个插件、也不下载 73MB 模型的前提下
# 也能读出画面里的字。同级 dsh-ocr 里的离线引擎更准（小字、中英混排差距明显），所以它是首选，
# 这里是地板，不是天花板。
#
# Windows 的识别器只能从 WinRT 够到，而 PowerShell 5.1 不能直接 await。下面三件事是承重的，
# 都是踩坏了才知道的：
#
#   1. WinRT 类型必须写成带 ContentType 标记的方括号字面量
#      （[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]）。
#      用 [Type]::GetType 运行时查出来的是 CLR 影子类型，拿它造出来的实例会被引擎拒绝，
#      报的是 "cannot convert Windows.Globalization.Language to Windows.Globalization.Language"。
#   2. 一行的包围盒是它所有单词的并集。识别器把中文切成一个字一个 word，所以第一个 word 的
#      矩形只有一个字宽。
#   3. stdout 必须强制成 UTF-8。PowerShell 5.1 默认写控制台代码页，中文到了 Node 父进程那边
#      就是乱码：文字是对的，但任何查找都匹配不上。
#
# 本文件必须保存为 **UTF-8 with BOM**：Windows PowerShell 5.1 读没有 BOM 的文件会按 GBK 解，
# 上面的中文注释和下面 JSON 里的中文都会变成乱码。（本仓库 .gitattributes 给 *.ps1 指定了
# eol=crlf，所以行尾是 CRLF。）
#
# 用法：
#   winrt-ocr.ps1 -Path frame.png [-Language zh-Hans-CN] [-Scale 2]
#
# 输出契约（稳定，调用方按它解析）：
#   成功：{"ok":true,"language":"…","lineCount":N,"elapsedMs":N,"scale":N,
#           "sourceWidth":W,"sourceHeight":H,"note":null,
#           "lines":[{"text":"…","confidence":null,"x":0,"y":0,"width":0,"height":0}]}
#   失败：{"ok":false,"error":"…"}          ← 永远是这个形状，不是 PowerShell 的调用栈
#
# 关于契约里几个字段的实话：
#   * confidence 恒为 null。Windows.Media.Ocr 不提供逐行置信度，编一个出来比诚实地说「没有」更糟。
#   * x/y/width/height 是**源图**像素坐标：-Scale 的放大在这里就除回去了，调用方拿到的一律是原图空间。
#   * sourceWidth/sourceHeight 是这个文件本身的画幅，不受 -Scale 影响。
#   * note 只在「要的语言没有、退到系统语言」时非 null。
#   * 失败时进程退出码是 2（不是 0）：JSON 说明白原因，退出码让 shell 那边也能判断。

param(
  [string]$Path,
  [string]$Language = 'zh-Hans-CN',
  # 刻意是字符串而不是 [int]：这样 "-Scale abc" 会变成一条 JSON 错误，
  # 而不是 PowerShell 参数绑定阶段的调用栈（那一段在 try 之前，抓不住）。
  [string]$Scale = '1'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# 只有一条通往 stdout 的路：任何失败都变成 { ok: false, error }。
function Write-JsonResult($payload) {
  Write-Output ($payload | ConvertTo-Json -Depth 5 -Compress)
}

function Fail($message) {
  Write-JsonResult ([ordered]@{ ok = $false; error = [string]$message })
  exit 2
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

try {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw '缺少 -Path：要识别的图片路径是必填的。' }

  $scaleValue = 0
  if (-not [int]::TryParse($Scale.Trim(), [ref]$scaleValue)) { throw "无法把 -Scale 解析成整数：$Scale（只接受 1–3）" }
  if ($scaleValue -lt 1) { $scaleValue = 1 }
  if ($scaleValue -gt 3) { $scaleValue = 3 }

  if (-not (Test-Path -LiteralPath $Path)) { throw "没有这个文件：$Path" }
  $sourcePath = (Resolve-Path -LiteralPath $Path).Path

  # 放大对识别小字有帮助；坐标随后除掉这个倍数，所以调用方拿到的仍然是原图空间。
  $source = [System.Drawing.Image]::FromFile($sourcePath)
  $sourceWidth = [int]$source.Width
  $sourceHeight = [int]$source.Height
  try {
    if ($scaleValue -gt 1) {
      $scaled = New-Object System.Drawing.Bitmap([int]($sourceWidth * $scaleValue), [int]($sourceHeight * $scaleValue))
      $graphics = [System.Drawing.Graphics]::FromImage($scaled)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($source, 0, 0, $scaled.Width, $scaled.Height)
      $graphics.Dispose()
      $source.Dispose()
      $source = $scaled
    }
    $stream = New-Object System.IO.MemoryStream
    $source.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $stream.Position = 0
  } finally {
    if ($source) { $source.Dispose() }
  }

  $decoderType = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
  $engineType = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $resultType = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]

  $randomAccess = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)
  $decoder = Await ($decoderType::CreateAsync($randomAccess)) $decoderType
  $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) $bitmapType

  $languageType = 'Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime'
  $engine = $engineType::TryCreateFromLanguage((New-Object $languageType -ArgumentList $Language))
  $note = $null
  if ($null -eq $engine) {
    # 要的语言没装就退到系统语言，并且**说出来**：读出来的字可能是另一种语言的模型读的。
    $engine = $engineType::TryCreateFromUserProfileLanguages()
    if ($null -ne $engine) {
      $note = "没有 $Language 的识别器，退到了系统语言 $($engine.RecognizerLanguage.LanguageTag)。"
    }
  }
  if ($null -eq $engine) { throw "这台机器没有任何可用的 Windows 识别器（要的是 $Language）" }

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $result = Await ($engine.RecognizeAsync($softwareBitmap)) $resultType
  $watch.Stop()
  $stream.Dispose()

  $lines = @()

  foreach ($line in $result.Lines) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }

    $minX = [double]::MaxValue
    $minY = [double]::MaxValue
    $maxX = [double]::MinValue
    $maxY = [double]::MinValue
    foreach ($word in $words) {
      $rect = $word.BoundingRect
      $wx = [double](@($rect.X)[0])
      $wy = [double](@($rect.Y)[0])
      $ww = [double](@($rect.Width)[0])
      $wh = [double](@($rect.Height)[0])
      if ($wx -lt $minX) { $minX = $wx }
      if ($wy -lt $minY) { $minY = $wy }
      if (($wx + $ww) -gt $maxX) { $maxX = $wx + $ww }
      if (($wy + $wh) -gt $maxY) { $maxY = $wy + $wh }
    }

    $lines += [ordered]@{
      text       = $line.Text
      # 见文件头：Windows 不给逐行置信度，所以这里是 null，而不是某个看起来很确定的数字。
      confidence = $null
      x          = [int]($minX / $scaleValue)
      y          = [int]($minY / $scaleValue)
      width      = [int](($maxX - $minX) / $scaleValue)
      height     = [int](($maxY - $minY) / $scaleValue)
    }
  }

  Write-JsonResult ([ordered]@{
    ok           = $true
    language     = $engine.RecognizerLanguage.LanguageTag
    lineCount    = $lines.Count
    elapsedMs    = [int]$watch.ElapsedMilliseconds
    scale        = $scaleValue
    sourceWidth  = $sourceWidth
    sourceHeight = $sourceHeight
    note         = $note
    lines        = @($lines)
  })
} catch {
  # 到这里的每一条路都变成契约里的失败形状：调用方永远不需要去读 PowerShell 的调用栈。
  Fail $_.Exception.Message
}
