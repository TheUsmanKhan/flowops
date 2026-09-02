#!/bin/bash
set -e
cd /home/z/my-project

export DATABASE_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
export DIRECT_URL="$DATABASE_URL"

./node_modules/.bin/next dev -p 3000 > dev.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/ 2>/dev/null && break; sleep 1; done
echo "server ready"

echo "=== login ==="
curl -s -c /tmp/ct.txt -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"usman@flowops.pk","password":"Test1234!"}' --max-time 40 -o /dev/null -w "%{http_code}\n"

echo "=== get IDs ==="
LOC_ID=$(curl -s -b /tmp/ct.txt http://127.0.0.1:3000/api/inventory-locations --max-time 30 | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); console.log(j.locations[0]?.id||'')")
SUP_ID=$(curl -s -b /tmp/ct.txt http://127.0.0.1:3000/api/suppliers --max-time 30 | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); console.log(j.suppliers[0]?.id||'')")
PROD_RESP=$(curl -s -b /tmp/ct.txt "http://127.0.0.1:3000/api/products" --max-time 30)
PRODUCT_ID=$(echo "$PROD_RESP" | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); console.log(j.products[0]?.id||'')")
VAR_ID=$(echo "$PROD_RESP" | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); console.log(j.products[0]?.variants[0]?.id||'')")
echo "location: $LOC_ID, supplier: $SUP_ID, product: $PRODUCT_ID, variant: $VAR_ID"

echo "=== create PO (ordered, 100 units @ Rs. 1500) ==="
PO_RESP=$(curl -s -b /tmp/ct.txt -X POST http://127.0.0.1:3000/api/purchase-orders -H "Content-Type: application/json" -d "{\"supplier_id\":\"$SUP_ID\",\"delivery_location_id\":\"$LOC_ID\",\"status\":\"ordered\",\"items\":[{\"org_variant_id\":\"$VAR_ID\",\"ordered_quantity\":100,\"cost_per_unit\":1500}]}")
echo "$PO_RESP" | head -c 200; echo
PO_ID=$(echo "$PO_RESP" | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); console.log(j.id||'')")

echo "=== receive 50 units @ Rs. 1600 (partial delivery, different cost) ==="
PO_DETAIL=$(curl -s -b /tmp/ct.txt "http://127.0.0.1:3000/api/purchase-orders/$PO_ID" --max-time 30)
PO_ITEM_ID=$(echo "$PO_DETAIL" | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); console.log(j.order?.items[0]?.id||'')")
echo "po_item_id: $PO_ITEM_ID"
RECEIVE_RESP=$(curl -s -b /tmp/ct.txt -X POST "http://127.0.0.1:3000/api/purchase-orders/$PO_ID/receive" -H "Content-Type: application/json" -d "{\"items\":[{\"purchase_order_item_id\":\"$PO_ITEM_ID\",\"org_variant_id\":\"$VAR_ID\",\"received_quantity\":50,\"actual_cost_per_unit\":1600}]}")
echo "$RECEIVE_RESP" | head -c 200; echo

echo "=== receive another 50 units @ Rs. 1400 (second delivery, different cost) ==="
RECEIVE2=$(curl -s -b /tmp/ct.txt -X POST "http://127.0.0.1:3000/api/purchase-orders/$PO_ID/receive" -H "Content-Type: application/json" -d "{\"items\":[{\"purchase_order_item_id\":\"$PO_ITEM_ID\",\"org_variant_id\":\"$VAR_ID\",\"received_quantity\":50,\"actual_cost_per_unit\":1400}]}")
echo "$RECEIVE2" | head -c 200; echo

echo "=== check inventory summary (should show 100 on_hand, WAC = (50*1600 + 50*1400)/100 = 1500) ==="
curl -s -b /tmp/ct.txt "http://127.0.0.1:3000/api/inventory/summary?product_id=$PRODUCT_ID" --max-time 30 | bun -e "
const d=await Bun.stdin.text();
const j=JSON.parse(d);
for(const v of j.variants||[]) {
  console.log('variant:', v.sku, '| onHand:', v.totalOnHand, '| reserved:', v.totalReserved, '| available:', v.totalAvailable);
  for(const loc of v.locations||[]) {
    console.log('  location:', loc.locationName, '| onHand:', loc.onHand, '| avgCost:', loc.avgCost, '| incoming:', loc.incoming);
  }
}
"

kill $SRV 2>/dev/null || true
echo "=== DONE ==="
