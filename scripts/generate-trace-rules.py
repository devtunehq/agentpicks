#!/usr/bin/env python3
"""ABOUTME: Generates a reproducible, pinned subset of MIT gitleaks rules for trace redaction."""
from pathlib import Path
import hashlib
import json
import tomllib

root = Path(__file__).resolve().parents[1]
source = root / 'vendor/gitleaks/gitleaks.toml'
rules = tomllib.loads(source.read_text())['rules']
dropped = {
    'generic-api-key': 'generic value shape relies on entropy rather than a provider signature',
    'facebook-access-token': 'requires the facebook keyword outside the regex',
    'airtable-personnal-access-token': 'requires the airtable keyword outside the regex',
    'pkcs12-file': 'file-path rule without a value regex',
}
assert set(dropped) <= {r['id'] for r in rules}
retained = [dict(id=r['id'], regex=r['regex'], keywords=r.get('keywords', []),
                 **({'secretGroup': r['secretGroup']} if 'secretGroup' in r else {}))
            for r in rules if r['id'] not in dropped]
header = f'''/**
 * ABOUTME: Generated trace value signatures from gitleaks v8.30.1, MIT license.
 * Source SHA256: {hashlib.sha256(source.read_bytes()).hexdigest()}
 * Regenerate: python3 packages/agentpicks/scripts/generate-trace-rules.py
 * License: ../../vendor/gitleaks/LICENSE. Retained {len(retained)} of {len(rules)} rules.
 * Dropped {len(dropped)} rules: entropy-only generic detection, external keyword context,
 * and file-path-only detection. Provider signatures with entropy thresholds are retained
 * conservatively without their entropy/allowlist exclusions. RE2JS executes Go regexes.
 */
'''
output = header + 'export const GITLEAKS_VERSION = "v8.30.1";\n'
output += 'export const GITLEAKS_DROPPED = ' + json.dumps(dropped, indent=2) + ' as const;\n'
output += 'export const GITLEAKS_RULES = ' + json.dumps(retained, indent=2) + ' as const;\n'
(root / 'src/run/trace-rules.generated.ts').write_text(output)
print(f'Generated {len(retained)} rules; dropped {len(dropped)}')
