#!/usr/bin/env python3
"""
Reverse Migration: State Table -> Admin Table

This script populates the SwarmAdmin-* table from existing avatar configs
in swarm-state-*. This is needed when avatars exist in the state table
(created by old system) but not in the admin table (new system).

Usage:
  python3 scripts/sync-state-to-admin.py staging [--dry-run]
  python3 scripts/sync-state-to-admin.py prod [--dry-run]
"""
import json
import subprocess
import sys
import time

def run_aws_cmd(cmd):
    """Run AWS CLI command and return parsed JSON output."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None, result.stderr
    try:
        return json.loads(result.stdout), None
    except json.JSONDecodeError:
        return result.stdout.strip(), None

def unmarshall_dynamodb(item):
    """Convert DynamoDB JSON format to regular Python dict."""
    if isinstance(item, dict):
        if len(item) == 1:
            key = list(item.keys())[0]
            if key == 'S':
                return item['S']
            elif key == 'N':
                val = item['N']
                return float(val) if '.' in val else int(val)
            elif key == 'BOOL':
                return item['BOOL']
            elif key == 'NULL':
                return None
            elif key == 'L':
                return [unmarshall_dynamodb(v) for v in item['L']]
            elif key == 'M':
                return {k: unmarshall_dynamodb(v) for k, v in item['M'].items()}
            elif key == 'SS':
                return set(item['SS'])
            elif key == 'NS':
                return {float(n) if '.' in n else int(n) for n in item['NS']}
        return {k: unmarshall_dynamodb(v) for k, v in item.items()}
    return item

def marshall_dynamodb(value):
    """Convert Python value to DynamoDB JSON format."""
    if value is None:
        return {'NULL': True}
    elif isinstance(value, bool):
        return {'BOOL': value}
    elif isinstance(value, str):
        return {'S': value}
    elif isinstance(value, (int, float)):
        return {'N': str(value)}
    elif isinstance(value, list):
        return {'L': [marshall_dynamodb(v) for v in value]}
    elif isinstance(value, dict):
        return {'M': {k: marshall_dynamodb(v) for k, v in value.items()}}
    elif isinstance(value, set):
        if all(isinstance(x, str) for x in value):
            return {'SS': list(value)}
        else:
            return {'NS': [str(x) for x in value]}
    return {'S': str(value)}

def convert_state_to_admin(state_item):
    """
    Convert a state table item to admin table AvatarRecord format.
    
    State table format:
      pk: AVATAR#<id>
      sk: CONFIG
      config: { id, name, persona, platforms, llm, voice, ... }
      status: draft|active|deleted
    
    Admin table format:
      pk: AVATAR#<id>
      sk: CONFIG
      avatarId: <id>
      name: string
      persona: string
      platforms: {...}
      llmConfig: {...}
      voiceConfig: {...}
      status: draft|active|deleted
      createdAt: number
      updatedAt: number
    """
    config = state_item.get('config', {})
    avatar_id = config.get('id', '')
    
    # Build the admin record
    admin_record = {
        'pk': f'AVATAR#{avatar_id}',
        'sk': 'CONFIG',
        'avatarId': avatar_id,
        'name': config.get('name', avatar_id),
        'persona': config.get('persona', ''),
        'description': '',
        'status': state_item.get('status', 'draft'),
        'currentEra': 0,
        'createdAt': state_item.get('syncedAt', int(time.time() * 1000)),
        'updatedAt': state_item.get('syncedAt', int(time.time() * 1000)),
        'createdBy': 'migration',
        'updatedBy': 'migration',
    }
    
    # Convert LLM config
    llm = config.get('llm', {})
    admin_record['llmConfig'] = {
        'provider': llm.get('provider', 'openrouter'),
        'model': llm.get('model', 'anthropic/claude-sonnet-4'),
        'temperature': llm.get('temperature', 0.8),
        'maxTokens': llm.get('maxTokens', 1024),
        'useGlobalKey': True,
    }
    
    # Convert voice config
    voice = config.get('voice', {})
    admin_record['voiceConfig'] = {
        'enabled': voice.get('enabled', True),
        'ttsProvider': voice.get('ttsProvider', 'voice-clone'),
        'format': voice.get('format', 'ogg'),
    }
    if voice.get('defaultVoiceId'):
        admin_record['voiceConfig']['defaultVoiceId'] = voice['defaultVoiceId']
    if voice.get('referenceUrl'):
        admin_record['voiceConfig']['referenceUrl'] = voice['referenceUrl']
    
    # Convert platforms
    platforms = config.get('platforms', {})
    admin_platforms = {}
    
    if platforms.get('telegram', {}).get('enabled'):
        tg = platforms['telegram']
        admin_platforms['telegram'] = {
            'enabled': True,
            'botUsername': tg.get('botUsername', ''),
        }
    
    if platforms.get('twitter', {}).get('enabled'):
        tw = platforms['twitter']
        admin_platforms['twitter'] = {
            'enabled': True,
            'username': tw.get('username', ''),
        }
    
    if platforms.get('discord', {}).get('enabled'):
        dc = platforms['discord']
        admin_platforms['discord'] = {
            'enabled': True,
            'mode': dc.get('mode', 'bot'),
            'useGateway': dc.get('useGateway', True),
            'respondToMentions': dc.get('respondToMentions', True),
            'respondInDMs': dc.get('respondInDMs', True),
        }
        if dc.get('applicationId'):
            admin_platforms['discord']['applicationId'] = dc['applicationId']
        if dc.get('publicKey'):
            admin_platforms['discord']['publicKey'] = dc['publicKey']
        if dc.get('allowedChannels'):
            admin_platforms['discord']['allowedChannels'] = dc['allowedChannels']
        if dc.get('allowedGuilds'):
            admin_platforms['discord']['allowedGuilds'] = dc['allowedGuilds']
    
    if platforms.get('web', {}).get('enabled'):
        admin_platforms['web'] = {'enabled': True}
    
    admin_record['platforms'] = admin_platforms
    
    return admin_record

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ['staging', 'prod']:
        print("Usage: python3 sync-state-to-admin.py <staging|prod> [--dry-run]")
        sys.exit(1)
    
    stage = sys.argv[1]
    dry_run = '--dry-run' in sys.argv
    
    state_table = f"swarm-state-{stage}"
    admin_table = f"SwarmAdmin-{stage}"
    
    print(f"\n🔄 Syncing State -> Admin for {stage.upper()}")
    print(f"   From: {state_table}")
    print(f"   To:   {admin_table}")
    if dry_run:
        print("   (DRY RUN - no changes will be made)\n")
    else:
        print()
    
    # Scan state table for AVATAR# configs
    scan_cmd = [
        'aws', 'dynamodb', 'scan',
        '--table-name', state_table,
        '--filter-expression', 'begins_with(pk, :prefix) AND sk = :sk',
        '--expression-attribute-values', '{ ":prefix": {"S": "AVATAR#"}, ":sk": {"S": "CONFIG"} }',
        '--output', 'json'
    ]
    
    data, err = run_aws_cmd(scan_cmd)
    if err:
        print(f"❌ Failed to scan state table: {err}")
        sys.exit(1)
    
    items = data.get('Items', [])
    print(f"📋 Found {len(items)} AVATAR# configs in state table\n")
    
    if not items:
        print("✅ Nothing to sync")
        return
    
    synced = 0
    skipped = 0
    failed = 0
    
    for raw_item in items:
        item = unmarshall_dynamodb(raw_item)
        avatar_id = item.get('config', {}).get('id', 'unknown')
        
        # Check if already exists in admin table
        check_cmd = [
            'aws', 'dynamodb', 'get-item',
            '--table-name', admin_table,
            '--key', json.dumps({'pk': {'S': f'AVATAR#{avatar_id}'}, 'sk': {'S': 'CONFIG'}}),
            '--query', 'Item.pk.S',
            '--output', 'text'
        ]
        check_result = subprocess.run(check_cmd, capture_output=True, text=True)
        exists = check_result.stdout.strip()
        if exists and exists != 'None':
            print(f"  ⏭️  Skip {avatar_id} - already in admin table")
            skipped += 1
            continue
        
        # Convert to admin format
        admin_record = convert_state_to_admin(item)
        
        if dry_run:
            print(f"  🔍 Would sync {avatar_id} (name: {admin_record['name']})")
            synced += 1
            continue
        
        # Write to admin table
        marshalled = {k: marshall_dynamodb(v) for k, v in admin_record.items()}
        put_cmd = [
            'aws', 'dynamodb', 'put-item',
            '--table-name', admin_table,
            '--item', json.dumps(marshalled)
        ]
        put_result = subprocess.run(put_cmd, capture_output=True, text=True)
        if put_result.returncode == 0:
            print(f"  ✅ Synced {avatar_id} (name: {admin_record['name']})")
            synced += 1
        else:
            print(f"  ❌ Failed {avatar_id}: {put_result.stderr}")
            failed += 1
    
    print(f"\n✅ Sync complete!")
    print(f"   Synced: {synced}")
    print(f"   Skipped: {skipped}")
    print(f"   Failed: {failed}")
    
    if dry_run:
        print("\n💡 Run without --dry-run to apply changes")

if __name__ == '__main__':
    main()
