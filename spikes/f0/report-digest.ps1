function Get-ReportDigest([string]$Path) {
    $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        [BitConverter]::ToString(
            $algorithm.ComputeHash($stream)
        ).Replace("-", "").ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}
