#!/usr/bin/env bash
# End-to-end API test. Usage: ./scripts/smoke-test.sh [base_url]
set -euo pipefail
B=${1:-http://localhost:8080}; J='Content-Type: application/json'
ok() { echo "[ok] $*"; }
field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -1; }

TOKEN=$(curl -fsS -X POST "$B/api/auth/login" -H "$J" -d '{"email":"admin@shop.local","password":"Admin@123"}' | field token)
[ -n "$TOKEN" ] && ok "admin login"
EMAIL="tester$RANDOM@example.com"
UT=$(curl -fsS -X POST "$B/api/auth/register" -H "$J" -d "{\"name\":\"Test User\",\"email\":\"$EMAIL\",\"password\":\"Password123\"}" | field token)
[ -n "$UT" ] && ok "registered $EMAIL"

LIST=$(curl -fsS "$B/api/products?limit=1")
PID=$(echo "$LIST" | sed -n 's/.*"id":"\([a-f0-9]\{24\}\)".*/\1/p' | head -1)
stock() { curl -fsS "$B/api/products/$PID" | sed -n 's/.*"stock":\([0-9]*\).*/\1/p'; }
BEFORE=$(stock); ok "product $PID stock=$BEFORE"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/products" -H "$J" -H "Authorization: Bearer $UT" -d '{"name":"x","price":1,"stock":1}')
[ "$CODE" = 403 ] && ok "non-admin blocked (403)"

ORDER=$(curl -fsS -X POST "$B/api/orders" -H "$J" -H "Authorization: Bearer $UT" -d "{\"items\":[{\"product_id\":\"$PID\",\"quantity\":2}]}")
OID=$(echo "$ORDER" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1); ok "order #$OID created"
[ "$(stock)" = "$((BEFORE-2))" ] && ok "stock decremented"
curl -fsS -X PATCH "$B/api/orders/$OID/status" -H "$J" -H "Authorization: Bearer $UT" -d '{"status":"cancelled"}' >/dev/null
[ "$(stock)" = "$BEFORE" ] && ok "cancel restored stock"
curl -fsS "$B/api/stats" -H "Authorization: Bearer $TOKEN" >/dev/null && ok "admin stats"
echo "All checks passed."
