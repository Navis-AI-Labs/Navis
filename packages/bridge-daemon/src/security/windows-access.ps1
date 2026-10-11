param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('protect-directory', 'check')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$LiteralPath
)
$ErrorActionPreference = 'Stop'
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Reparse points cannot store private state.'
  }
  $acl = Get-Acl -LiteralPath $LiteralPath
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
  $adminOwner = $owner -eq 'S-1-5-32-544' -and $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($owner -ne $identity.Value -and -not $adminOwner) { throw 'Private state must be owned by the current user.' }
  if ($Action -eq 'protect-directory') {
    if (-not $item.PSIsContainer) { throw 'Private state requires a directory.' }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($identity)
    foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($entry) }
    foreach ($sid in @($identity, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $LiteralPath -AclObject $acl
  } else {
    $allowed = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
    foreach ($entry in $acl.Access) {
      if ($entry.AccessControlType -eq 'Allow') {
        $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($allowed -notcontains $sid) { throw 'Private state grants access to another identity.' }
      }
    }
  }
} catch {
  [Console]::Error.WriteLine('Private state access-control validation failed.')
  exit 1
}
