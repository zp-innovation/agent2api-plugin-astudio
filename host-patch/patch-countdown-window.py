#!/usr/bin/env python3
"""Patch the panel bundle: extend credit expiry window from 7 to 30 days.

Changes 4 byte patterns in /app/ui/islands/ui.js:
  1. const k_=7*864e5;          -> const k_=30*864e5;   (window constant)
  2. badge "7天 {count}份"       -> "30天 {count}份"      (multi-item badge)
  3. badge "7天 {n}"             -> "30天 {n}"           (single-item badge)
  4. summary "7 天内到期"        -> "30 天内到期"        (summary text)

Only touches the countdown/expiry badge strings. Other "7 天" occurrences
(filters, date labels) are left unchanged.
"""
import subprocess, sys, hashlib

CONTAINER = "agent2api"
BUNDLE = "/app/ui/islands/ui.js"
BUNDLE_BAK = "/app/ui/islands/ui.js.a2a-countdown-orig"

r = subprocess.run(["docker", "exec", CONTAINER, "cat", BUNDLE], capture_output=True)
if r.returncode != 0:
    print("FAIL: cannot read bundle:", r.stderr.decode()[:200])
    sys.exit(1)
data = r.stdout

if b"30*864e5" in data:
    print("Already patched, skipping")
    sys.exit(0)

# Back up original
subprocess.run(["docker", "exec", CONTAINER, "cp", BUNDLE, BUNDLE_BAK], check=True)

replacements = [
    (b"const k_=7*864e5;", b"const k_=30*864e5;"),
    (b't("7\xe5\xa4\xa9 {count}\xe4\xbb\xbd"', b't("30\xe5\xa4\xa9 {count}\xe4\xbb\xbd"'),
    (b't("7\xe5\xa4\xa9 {n}"', b't("30\xe5\xa4\xa9 {n}"'),
    (b't("7 \xe5\xa4\xa9\xe5\x86\x85\xe5\x88\xb0\xe6\x9c\x9f {amount}', b't("30 \xe5\xa4\xa9\xe5\x86\x85\xe5\x88\xb0\xe6\x9c\x9f {amount}'),
]

for old, new in replacements:
    count = data.count(old)
    label = old[:50].decode('utf-8', errors='replace')
    print(f"  {label}... -> {count} occurrence(s)")
    if count == 0:
        print("  WARNING: pattern not found!")
    data = data.replace(old, new)

tmp = "/tmp/ui.js.patched"
with open(tmp, "wb") as f:
    f.write(data)

subprocess.run(["docker", "cp", tmp, f"{CONTAINER}:{BUNDLE}"], check=True)

print("Done. New size:", len(data), "sha256:", hashlib.sha256(data).hexdigest())
