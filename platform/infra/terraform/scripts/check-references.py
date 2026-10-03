#!/usr/bin/env python3
"""Static cross-reference check for the Terraform code, usable without downloading providers (terraform validate needs them).

Checks, per module and for the root: every var.X used is declared; every module output used (module.m.o) exists; every resource or data reference
(aws_x.y, data.aws_x.y, random_x.y) names something declared in the same module; every declared variable is used somewhere; every required module
input is passed by the caller and no unknown input is passed. It does NOT check provider attribute names or types: only `terraform validate` /
`terraform plan` can. Run:  python3 scripts/check-references.py
"""
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
problems = []

def strip(s: str) -> str:
    s = re.sub(r'(?m)^\s*#.*$', '', s); s = re.sub(r'(?m)(^|\s)//.*$', r'\1', s)  # a // inside a URL string is not a comment
    return re.sub(r'"(?:[^"\\]|\\.)*"', lambda m: m.group(0), s)

def read(d: pathlib.Path) -> str:
    return '\n'.join(strip(p.read_text()) for p in sorted(d.glob('*.tf')))

def declared_vars(t):  return {m.group(1): m.group(0) for m in re.finditer(r'variable\s+"(\w+)"\s*\{', t)}
def declared_outputs(t): return set(re.findall(r'output\s+"(\w+)"\s*\{', t))
def declared_res(t):
    r = {f'{a}.{b}' for a, b in re.findall(r'(?m)^\s*resource\s+"(\w+)"\s+"(\w+)"', t)}
    d = {f'data.{a}.{b}' for a, b in re.findall(r'(?m)^\s*data\s+"(\w+)"\s+"(\w+)"', t)}
    return r | d

def used_res(t):
    refs = set()
    for m in re.finditer(r'(?<![\w."])(data\.)?((?:aws|random)_\w+)\.(\w+)', t):
        # skip occurrences inside a quoted string literal that is plain text (e.g. "aws_x.y" in descriptions)
        refs.add(f'{m.group(1) or ""}{m.group(2)}.{m.group(3)}')
    return refs

def has_required(block: str) -> bool: return 'default' not in block

mods = {p.name: p for p in (root / 'modules').iterdir() if p.is_dir()}
texts = {n: read(p) for n, p in mods.items()}; texts['(root)'] = read(root)

for name, t in texts.items():
    dv = declared_vars(t); used = set(re.findall(r'\bvar\.(\w+)', t))
    for u in sorted(used - set(dv)): problems.append(f'{name}: var.{u} is used but not declared')
    for u in sorted(set(dv) - used): problems.append(f'{name}: variable "{u}" is declared but never used')
    decl = declared_res(t)
    for r in sorted(used_res(t) - decl):
        # attribute-looking tails of a declared resource, e.g. aws_lb.this.dns_name, are matched on the first two segments only
        problems.append(f'{name}: reference to {r} but nothing with that name is declared in this module')
    for m in re.finditer(r'module\.(\w+)\.(\w+)', t):
        mod, out = m.groups()
        if mod not in mods: problems.append(f'{name}: module.{mod} does not exist')
        elif out not in declared_outputs(texts[mod]): problems.append(f'{name}: module.{mod}.{out} is not an output of that module')

# module calls in the root: inputs match
for m in re.finditer(r'module\s+"(\w+)"\s*\{(.*?)\n\}', texts['(root)'], re.S):
    name, body = m.groups(); src = re.search(r'source\s*=\s*"\./modules/(\w+)"', body)
    if not src: continue
    target = src.group(1); dv = declared_vars(texts[target]); given = set(re.findall(r'(?m)^\s*(\w+)\s*=', body)) - {'source', 'providers'}
    required = {k for k, v in dv.items() if has_required(v) and not re.search(r'default\s*=', re.search(r'variable\s+"%s"\s*\{(.*?)\n?\}' % k, texts[target], re.S).group(0))}
    for k in sorted(required - given): problems.append(f'module "{name}" does not pass required input {k}')
    for k in sorted(given - set(dv)): problems.append(f'module "{name}" passes {k}, which {target} does not declare')

if problems:
    print('\n'.join(problems)); sys.exit(1)
print(f'references OK across {len(texts)} modules')
