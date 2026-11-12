# Trace value rules

`gitleaks.toml` and `LICENSE` are unmodified copies from gitleaks v8.30.1 (MIT).
The generated module records the source SHA256. Regenerate it with:

```sh
python3 packages/agentpicks/scripts/generate-trace-rules.py
```

Of 222 upstream rules, 218 are retained. `generic-api-key` depends on entropy;
`facebook-access-token` and upstream's `airtable-personnal-access-token` need keyword
context outside their regex; `pkcs12-file` has no value regex. Those four are omitted.
Provider signatures that also have entropy thresholds are retained conservatively
without entropy/allowlist exclusions. RE2JS executes the original Go regex syntax.

Updating the pin requires replacing the upstream files, reviewing exclusions,
regenerating, and running the redaction table spec and the full package suite.
