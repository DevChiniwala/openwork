$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Join-Path ([IO.Path]::GetTempPath()) ('exp-sign-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$certificate = $null
$previousManifest = $env:WINDOWS_PRESERVED_SIGNATURES
$previousCertificate = $env:WINDOWS_TEST_CERTIFICATE_SHA1
$script = Join-Path $PSScriptRoot 'windows-signatures.ps1'
function Invoke-TestScript([string[]]$Arguments) {
    & pwsh -NoProfile -NonInteractive -File $script @Arguments
    return $LASTEXITCODE
}
try {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=exp-sign-test' -CertStoreLocation Cert:\CurrentUser\My
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
    $store.Open('ReadWrite'); $store.Add($certificate); $store.Close()
    $env:WINDOWS_TEST_CERTIFICATE_SHA1 = $certificate.Thumbprint
    $env:WINDOWS_PRESERVED_SIGNATURES = Join-Path $root 'preserved.jsonl'
    $payload = Join-Path $root 'payload'
    New-Item -ItemType Directory -Path $payload | Out-Null
    $native = Join-Path $payload 'native.node'
    Add-Type -TypeDefinition 'public class SigningFixture { public static int Value() { return 42; } }' -OutputAssembly $native -OutputType Library
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Sign', '-Path', $native))
    if ($output[-1] -ne 0) { throw 'Unsigned PE was not signed' }
    if ((Get-AuthenticodeSignature -LiteralPath $native).SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'Wrong test signer' }
    $installer = Join-Path $root 'installer.exe'
    Copy-Item $native $installer
    $thirdParty = Join-Path $payload 'cmd.exe'
    Copy-Item "$env:SystemRoot\System32\cmd.exe" $thirdParty
    $before = (Get-FileHash $thirdParty).Hash
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Sign', '-Path', $thirdParty))
    if ($output[-1] -ne 0 -or (Get-FileHash $thirdParty).Hash -ne $before) { throw 'Valid third-party binary changed' }
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer, '-Report', (Join-Path $root 'valid.json')))
    if ($output[-1] -ne 0) { throw 'Valid payload rejected' }
    $rows = @(Get-Content (Join-Path $root 'valid.json') -Raw | ConvertFrom-Json)
    if ($rows.Count -ne 2 -or @($rows | Where-Object { -not $_.accepted }).Count) { throw 'Incomplete PE verification' }
    if (-not ($rows | Where-Object file -eq 'cmd.exe').preserved) { throw 'Third-party preservation was not verified' }
    Remove-Item $env:WINDOWS_PRESERVED_SIGNATURES
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Unexpected publisher accepted without preservation evidence' }
    $bytes = [IO.File]::ReadAllBytes($native); $bytes[40] = $bytes[40] -bxor 1; [IO.File]::WriteAllBytes($native, $bytes)
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Sign', '-Path', $native) 2>&1)
    if ($output[-1] -eq 0) { throw 'Tampered signature replaced' }
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Tampered payload accepted' }
    Remove-Item $native, $thirdParty
    $output = @(Invoke-TestScript -Arguments @('-Mode', 'Verify', '-Path', $payload, '-Installer', $installer) 2>&1)
    if ($output[-1] -eq 0) { throw 'Empty payload accepted' }
    Write-Host 'Passed: native PE signing, valid third-party byte preservation, publisher provenance, tamper rejection, empty-payload rejection'
} finally {
    $env:WINDOWS_PRESERVED_SIGNATURES = $previousManifest
    $env:WINDOWS_TEST_CERTIFICATE_SHA1 = $previousCertificate
    if ($certificate) {
        Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
        Remove-Item "Cert:\LocalMachine\Root\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
    }
    Remove-Item $root -Recurse -Force
}
