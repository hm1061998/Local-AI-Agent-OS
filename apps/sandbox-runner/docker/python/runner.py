import importlib.util, json, sys, traceback
try:
    with open('/input/input.json', encoding='utf-8') as source:
        value = json.load(source)
    spec = importlib.util.spec_from_file_location('skill', '/skill/src/skill.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, 'run', None)):
        raise RuntimeError('SKILL_RUN_MISSING')
    output = module.run(value)
    with open('/output/output.json', 'w', encoding='utf-8') as target:
        json.dump(output, target)
except Exception:
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
