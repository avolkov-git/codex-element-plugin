param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourcePath = (Get-Item -LiteralPath $Source).FullName.TrimEnd([char]'\', [char]'/')
$rootName = [System.IO.Path]::GetFileName($sourcePath)
$archive = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    # Compress-Archive on Windows PowerShell can emit backslashes in ZIP entry names.
    foreach ($file in Get-ChildItem -LiteralPath $sourcePath -File -Recurse -Force) {
        $relative = $file.FullName.Substring($sourcePath.Length + 1).Replace('\', '/')
        $entryName = $rootName + '/' + $relative
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
        )
    }
} finally {
    $archive.Dispose()
}
