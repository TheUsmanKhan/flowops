#!/bin/bash
set -e
cd /home/z/my-project

export DATABASE_URL="postgresql://postgres.flafcggvqfgyafzekxzk:123%40Usman123%40@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
export DIRECT_URL="$DATABASE_URL"

# Start server
./node_modules/.bin/next dev -p 3000 > dev.log 2>&1 &
SRV=$!
echo "server pid: $SRV"
for i in $(seq 1 40); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/ 2>/dev/null && break; sleep 1; done
echo "server ready"

echo "=== 1. Register fresh user ==="
curl -s -c /tmp/c9.txt -X POST http://127.0.0.1:3000/api/auth/register -H "Content-Type: application/json" -d '{"fullName":"Sana Malik","email":"sana@flowops.pk","password":"Test1234!","confirmPassword":"Test1234!"}' --max-time 40 -o /dev/null -w "register: %{http_code}\n"

echo "=== 2. Create Organization (Sana Group + Sana Boutique) ==="
curl -s -b /tmp/c9.txt -X POST http://127.0.0.1:3000/api/organizations/create -H "Content-Type: application/json" -d '{"org_name":"Sana Group","company_name":"Sana Boutique","base_currency":"PKR","country_code":"PK","province":"Punjab","city":"Lahore","timezone":"Asia/Karachi","fiscal_year_start":1}' --max-time 60 > /tmp/r1.json -w "create-org: %{http_code}\n"
cat /tmp/r1.json | bun -e "const d=await Bun.stdin.text(); try{const j=JSON.parse(d); console.log('  ✓ company:', j.activeCompany?.name, '| role:', j.employee?.roleName, '| elevated:', j.employee?.isElevated)}catch{console.log('  ✗', d.slice(0,200))}"

echo "=== 3. Create second company under same org ==="
# First get the org_id from the workspaces API
ORG_ID=$(curl -s -b /tmp/c9.txt http://127.0.0.1:3000/api/workspaces --max-time 30 | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); console.log(j.workspaces?.[0]?.org_id||'')")
echo "  org_id: $ORG_ID"
curl -s -b /tmp/c9.txt -X POST http://127.0.0.1:3000/api/companies/create -H "Content-Type: application/json" -d "{\"organization_id\":\"$ORG_ID\",\"company_name\":\"Sana Online Store\",\"base_currency\":\"USD\",\"country_code\":\"PK\",\"city\":\"Karachi\",\"timezone\":\"Asia/Karachi\",\"fiscal_year_start\":1}" --max-time 60 > /tmp/r2.json -w "create-company2: %{http_code}\n"
cat /tmp/r2.json | bun -e "const d=await Bun.stdin.text(); try{const j=JSON.parse(d); console.log('  ✓ company:', j.activeCompany?.name, '| companies:', j.companies?.length)}catch{console.log('  ✗', d.slice(0,200))}"

echo "=== 4. Workspaces API (should show 1 org, 2 companies) ==="
curl -s -b /tmp/c9.txt http://127.0.0.1:3000/api/workspaces --max-time 30 | bun -e "const d=await Bun.stdin.text(); const j=JSON.parse(d); for(const g of j.workspaces||[]) {console.log('  org:', g.org_name, '| owner:', g.is_owner, '| companies:', g.companies.length); for(const c of g.companies) console.log('    -', c.company_name, '|', c.role_name, '| active:', c.is_active_workspace)}"

echo "=== 5. DB verify ==="
bun -e "import {PrismaClient} from '@prisma/client';const p=new PrismaClient();const cs=await p.company.findMany({include:{_count:{select:{roles:true,employees:true}}}});for(const c of cs)console.log('  ✓',c.name,'| roles:',c._count.roles,'| emp:',c._count.employees);await p.\$disconnect();"

kill $SRV 2>/dev/null || true
echo "=== DONE ==="
