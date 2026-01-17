#!/usr/bin/env python3
"""
Migration script: AGENT# -> AVATAR#

This script migrates avatar configs from the old AGENT# prefix to AVATAR# prefix
in the swarm-state-* DynamoDB tables.

Usage:
  python3 scripts/migrate-agent-to-avatar.py staging
  python3 scripts/migrate-agent-to-avatar.py prod
"""
import json
import subprocess
import sys

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ['staging', 'prod']:
        print("Usage: python3 migrate-agent-to-avatar.py <staging|prod>")
        sys.exit(1)
    
    stage = sys.argv[1]
    table = f"swarm-state-{stage}"
    
    print(f"\n🚀 Migrating AGENT# -> AVATAR# for {stage.upper()}")
    print(f"   Table: {table}\n")
    
    # Scan for AGENT# configs
    scan_cmd = [
        'aws', 'dynamodb', 'scan',
        '--table-name', table,
        '--filter-expression', 'begins_with(pk, :prefix) AND sk = :sk',
        '--expression-attribute-values', '{ ":prefix": {"S": "AGENT#"}, ":sk": {"S": "CONFIG"} }',
        '--output', 'json'
    ]
    
    result = subprocess.run(scan_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"❌ Failed to scan table: {result.stderr}")
        sys.exit(1)
    
    data = json.loads(result.stdout)
    items = data.get('Items', [])
    print(f"📋 Found {len(items)} AGENT# configs to migrate\n")
    
    if not items:
        print("✅ Nothing to migrate")
        return
    
    migrated = 0
    skipped = 0
    failed = 0
    
    for item in items:
        old_pk = item['pk']['S']
        avatar_id = old_pk.replace('AGENT#', '')
        new_pk = f'AVATAR#{avatar_id}'
        
        # Check if AVATAR# already exists
        check_cmd = [
            'aws', 'dynamodb', 'get-item',
            '--table-name', table,
            '--key', json.dumps({'pk': {'S': new_pk}, 'sk': {'S': 'CONFIG'}}),
            '--query', 'Item.pk.S',
            '--output', 'text'
        ]
        check_result = subprocess.run(check_cmd, capture_output=True, text=True)
        exists = check_result.stdout.strip()
        if exists and exists != 'None':
            print(f"  ⏭️  Skip {new_pk} - already exists")
            skipped += 1
            continue
        
        # Create new item with AVATAR# prefix
        new_item = json.loads(json.dumps(item))  # deep copy
        new_item['pk']['S'] = new_pk
        
        # Put the new item
        put_cmd = [
            'aws', 'dynamodb', 'put-item',
            '--table-name', table,
            '--item', json.dumps(new_item)
        ]
        put_result = subprocess.run(put_cmd, capture_output=True, text=True)
        if put_result.returncode == 0:
            print(f"  ✅ Migrated {old_pk} -> {new_pk}")
            migrated += 1
        else:
            print(f"  ❌ Failed {old_pk}: {put_result.stderr}")
            failed += 1
    
    print(f"\n✅ Migration complete!")
    print(f"   Migrated: {migrated}")
    print(f"   Skipped: {skipped}")
    print(f"   Failed: {failed}")

if __name__ == '__main__':
    main()
