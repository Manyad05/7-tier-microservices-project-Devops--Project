# End-to-end API test through the frontend/gateway. Usage: ./scripts/smoke-test.ps1 [-Base http://localhost:8080]
param([string]$Base = "http://localhost:8080")
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "[ok] $m" -ForegroundColor Green }

$login = Invoke-RestMethod "$Base/api/auth/login" -Method Post -ContentType 'application/json' -Body '{"email":"admin@shop.local","password":"Admin@123"}'
$h = @{ Authorization = "Bearer $($login.token)" }
Step "admin login ($($login.user.email), role $($login.user.role))"

$email = "tester$(Get-Random)@example.com"
$reg = Invoke-RestMethod "$Base/api/auth/register" -Method Post -ContentType 'application/json' -Body (@{name='Test User';email=$email;password='Password123'} | ConvertTo-Json)
$uh = @{ Authorization = "Bearer $($reg.token)" }
Step "registered $email"

$p = Invoke-RestMethod "$Base/api/products?limit=3"
Step "listed products (total $($p.total))"
$pid1 = $p.items[0].id; $before = $p.items[0].stock

try { Invoke-RestMethod "$Base/api/products" -Method Post -Headers $uh -ContentType 'application/json' -Body '{"name":"x","price":1,"stock":1}' | Out-Null; throw "non-admin could create product" }
catch { if ($_.Exception.Message -like '*non-admin*') { throw } ; Step "non-admin blocked from creating products" }

$order = Invoke-RestMethod "$Base/api/orders" -Method Post -Headers $uh -ContentType 'application/json' -Body (@{items=@(@{product_id=$pid1;quantity=2})} | ConvertTo-Json -Depth 5)
Step "order #$($order.id) created, total $($order.total)"
$after = (Invoke-RestMethod "$Base/api/products/$pid1").stock
if ($after -ne $before - 2) { throw "stock not decremented ($before -> $after)" }
Step "stock decremented $before -> $after"

Invoke-RestMethod "$Base/api/orders/$($order.id)/status" -Method Patch -Headers $uh -ContentType 'application/json' -Body '{"status":"cancelled"}' | Out-Null
$restored = (Invoke-RestMethod "$Base/api/products/$pid1").stock
if ($restored -ne $before) { throw "stock not restored ($restored)" }
Step "cancel restored stock ($restored)"

$stats = Invoke-RestMethod "$Base/api/stats" -Headers $h
Step "admin stats: $($stats.orders.count) orders, $($stats.products.total) products, $($stats.users.total) users"
Write-Host "`nAll checks passed." -ForegroundColor Green
