param([ValidateSet('protect','unprotect')][string]$Operation)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$Payload = [Console]::In.ReadToEnd()
$Entropy = [Text.Encoding]::UTF8.GetBytes('Topolumia.SSH.Credentials.v1')
if ($Operation -eq 'protect') {
  $Bytes = [Text.Encoding]::UTF8.GetBytes($Payload)
  $Protected = [Security.Cryptography.ProtectedData]::Protect($Bytes, $Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($Protected))
} else {
  $Bytes = [Convert]::FromBase64String($Payload.Trim())
  $Plain = [Security.Cryptography.ProtectedData]::Unprotect($Bytes, $Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($Plain))
}
