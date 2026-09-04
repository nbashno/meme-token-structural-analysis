# WAR ARENA - add GMGN rug-ratio warning banner. No here-strings (base64-safe).
# Run from project root:  powershell -ExecutionPolicy Bypass -File .\add-rug-warning.ps1
$ErrorActionPreference = 'Stop'
$path = '.\miniapp\index.html'
if (-not (Test-Path $path)) { Write-Host 'ERROR: run from project root' -ForegroundColor Red; exit 1 }
$enc = New-Object System.Text.UTF8Encoding($false)
$text = [IO.File]::ReadAllText((Resolve-Path $path), $enc)
$d = [Text.Encoding]::UTF8
$cssAnchor = $d.GetString([Convert]::FromBase64String('ICAucGFydGlhbGJhcntmb250LWZhbWlseTp2YXIoLS1tb25vKTtmb250LXNpemU6MTBweDtjb2xvcjp2YXIoLS1nb2xkKTtiYWNrZ3JvdW5kOnJnYmEoMjQwLDE4Miw3NywuMSk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI0MCwxODIsNzcsLjMpO2JvcmRlci1yYWRpdXM6OXB4O3BhZGRpbmc6N3B4IDExcHg7bWFyZ2luLXRvcDoxMXB4O2xpbmUtaGVpZ2h0OjEuNDV9'))
$cssNew    = $d.GetString([Convert]::FromBase64String('ICAucGFydGlhbGJhcntmb250LWZhbWlseTp2YXIoLS1tb25vKTtmb250LXNpemU6MTBweDtjb2xvcjp2YXIoLS1nb2xkKTtiYWNrZ3JvdW5kOnJnYmEoMjQwLDE4Miw3NywuMSk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI0MCwxODIsNzcsLjMpO2JvcmRlci1yYWRpdXM6OXB4O3BhZGRpbmc6N3B4IDExcHg7bWFyZ2luLXRvcDoxMXB4O2xpbmUtaGVpZ2h0OjEuNDV9CiAgLnJ1Z3dhcm57Zm9udC1mYW1pbHk6dmFyKC0tbW9ubyk7Zm9udC1zaXplOjExcHg7Y29sb3I6I2ZmNmI2YjtiYWNrZ3JvdW5kOnJnYmEoMjQwLDYwLDYwLC4xMik7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI0MCw2MCw2MCwuNDUpO2JvcmRlci1yYWRpdXM6OXB4O3BhZGRpbmc6OXB4IDEycHg7bWFyZ2luLXRvcDoxMXB4O2xpbmUtaGVpZ2h0OjEuNTtmb250LXdlaWdodDo2MDB9'))
$jsAnchor  = $d.GetString([Convert]::FromBase64String('ICBpZihwYXJ0aWFsKXs='))
$jsNew     = $d.GetString([Convert]::FromBase64String('ICAvLyBQcm9taW5lbnQgcnVnLXJhdGlvIHdhcm5pbmc6IEdNR04ncyBydWdfcmF0aW8gaXMgc2hvd24gUkFXIG5leHQgdG8gdGhlIFdBUgogIC8vIHNjb3JlLCBub3QgZm9sZGVkIGludG8gaXQuIEhpZ2ggdmFsdWVzIG9uIHZlcnkgbmV3IHRva2VucyBjYW4gYmUgbm9pc3ksIHNvCiAgLy8gd2Ugc3VyZmFjZSB0aGUgc2lnbmFsIGFuZCBsZXQgdGhlIHVzZXIganVkZ2UgcmF0aGVyIHRoYW4gc2lsZW50bHkgY2FwcGluZy4KICBjb25zdCByciA9ICh3LnN0YXRzICYmIHR5cGVvZiB3LnN0YXRzLnJ1Z1JhdGlvID09PSAibnVtYmVyIikgPyB3LnN0YXRzLnJ1Z1JhdGlvIDogbnVsbDsKICBpZihyciAhPSBudWxsICYmIHJyID4gMC41KXsKICAgIGh0bWwgKz0gIjxkaXYgY2xhc3M9J3J1Z3dhcm4nPldBUk5JTkcgLSBHTUdOIFJVRyBSQVRJTzogIitNYXRoLnJvdW5kKHJyKjEwMCkrIiUgLSBoaWdoIHJ1Zy1wYXR0ZXJuIHNpZ25hbC4gVmVyaWZ5IHRoZSBjb250cmFjdCB5b3Vyc2VsZiBiZWZvcmUgYW55IHBvc2l0aW9uLjwvZGl2PiI7CiAgfQoKICBpZihwYXJ0aWFsKXs='))
$changes = 0
if ($text -notlike '*rugwarn{*') {
  if ($text.Contains($cssAnchor)) { $text = $text.Replace($cssAnchor, $cssNew); $changes++; Write-Host '  CSS added' -ForegroundColor Green }
  else { Write-Host '  CSS anchor not found' -ForegroundColor Yellow }
} else { Write-Host '  CSS already present' -ForegroundColor DarkGray }
if ($text -notlike '*GMGN RUG RATIO*') {
  $i = $text.IndexOf($jsAnchor)
  if ($i -ge 0) { $text = $text.Substring(0,$i) + $jsNew + $text.Substring($i + $jsAnchor.Length); $changes++; Write-Host '  JS added' -ForegroundColor Green }
  else { Write-Host '  JS anchor not found' -ForegroundColor Yellow }
} else { Write-Host '  JS already present' -ForegroundColor DarkGray }
if ($changes -gt 0) { [IO.File]::WriteAllText((Resolve-Path $path), $text, $enc); Write-Host "Done - $changes change(s)" -ForegroundColor Cyan }
else { Write-Host 'No changes needed' -ForegroundColor Cyan }