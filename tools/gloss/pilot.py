#!/usr/bin/env python3
"""Standard-library-only, resumable Codex/OpenCode CLI gloss pilot (never full-corpus)."""
import argparse, csv, hashlib, json, random, re, subprocess, tempfile, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/research/gloss-pilot'
LEVELS = ['A1','A2','B1','B2','C1','C2']
MODELS = ['gpt-6-luna','gpt-6.1-sol','opencode/deepseek-v4.1-flash-free']
OPENCODE_MODELS = {'opencode/deepseek-v4.1-flash-free'}
MODEL_DIRS = {'opencode/deepseek-v4.1-flash-free':'deepseek-v4.1-flash-free'}
LABELS = {'n':'n.','v':'v.','a':'adj.','r':'adv.'}
SEED = 20261031

def model_dir(model):
    return MODEL_DIRS.get(model, model)

def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')

def sample():
    packs = {n: json.loads((ROOT/f'public/data/{n}.json').read_text()) for n in ['cefrj','octanove','oewn']}
    levels, variants = {}, {}
    for name in ['cefrj','octanove']:
        for lemma,(level,aliases,*_) in packs[name]['entries'].items():
            levels[lemma] = min(levels.get(lemma,level),level,key=LEVELS.index)
            variants[lemma] = list(dict.fromkeys(variants.get(lemma,[])+aliases))
    for lemma, aliases in variants.items():
        for alias in aliases:
            if alias != lemma and alias in levels:
                levels[lemma] = min(levels[lemma],levels.pop(alias),key=LEVELS.index)
    dictionary = {}
    for lemma, groups in packs['oewn']['entries'].items():
        merged = {}
        for pos, definitions in groups.items():
            base = pos.split('-')[0]
            merged[base] = list(dict.fromkeys(merged.get(base, []) + definitions))
        dictionary[lemma] = merged
    rng = random.Random(SEED)
    selected = []
    required = ['light','present','lead','bank','run']
    for level,count in [(x,40) for x in LEVELS]+[('Unleveled',60)]:
        pool = sorted(w for w in dictionary if levels.get(w,'Unleveled') == level)
        forced = [w for w in required if w in pool]
        chosen = sorted(forced+rng.sample([w for w in pool if w not in forced],count-len(forced)))
        selected += [{'lemma':w,'level':level,'pos':sorted(dictionary[w]),'oewn':dictionary[w]} for w in chosen]
    dump(OUT/'sample.json', {'seed':SEED,'sources':{n:hashlib.sha256((ROOT/f'public/data/{n}.json').read_bytes()).hexdigest() for n in packs},'words':selected})

def validate(word, result):
    errors = []
    if not isinstance(result,dict) or result.get('lemma') != word['lemma']:
        return ['missing or wrong lemma']
    groups = result.get('glosses')
    if not isinstance(groups,list): return ['glosses must be an array']
    poses = [g.get('pos') if isinstance(g,dict) else None for g in groups]
    if sorted(str(p) for p in poses) != sorted(word['pos']): errors.append('missing, extra or duplicate POS')
    for g in groups:
        if not isinstance(g,dict): errors.append('invalid group'); continue
        senses = g.get('senses')
        if not isinstance(senses,list) or not 1 <= len(senses) <= 3:
            errors.append('sense count outside 1..3'); continue
        if len(set(map(str,senses))) != len(senses): errors.append('duplicate sense')
        for s in senses:
            if not isinstance(s,str) or not re.fullmatch(r'[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U000323af]{1,10}',s): errors.append('sense must be 1..10 Han characters')
    return sorted(set(errors))

def opencode_answer(events_path):
    """Concatenate the final text parts emitted by `opencode run --format json`."""
    parts=[]
    for line in events_path.read_text().splitlines():
        if not line.strip(): continue
        event=json.loads(line)
        if event.get('type')=='text': parts.append(event['part']['text'])
    return ''.join(parts)

def cli_version(executable):
    try:
        result = subprocess.run([executable,'--version'],capture_output=True,text=True,timeout=30)
    except OSError:
        return None
    return (result.stdout or result.stderr).strip() or None

def generate(model, batch_size):
    words = json.loads((OUT/'sample.json').read_text())['words']
    if not 1 <= len(words) <= 300 or len({w['lemma'] for w in words}) != len(words):
        raise ValueError('Pilot requires 1..300 unique lemmas')
    prompt = (ROOT/'tools/gloss/prompt.txt').read_text()
    schema = {'type':'object','properties':{'words':{'type':'array','items':{'type':'object','properties':{'lemma':{'type':'string'},'glosses':{'type':'array','items':{'type':'object','properties':{'pos':{'type':'string'},'senses':{'type':'array','items':{'type':'string'}}},'required':['pos','senses'],'additionalProperties':False}}},'required':['lemma','glosses'],'additionalProperties':False}}},'required':['words'],'additionalProperties':False}
    folder = OUT/model_dir(model)
    folder.mkdir(exist_ok=True)
    # An empty cwd prevents project AGENTS instructions from contaminating generation.
    with tempfile.TemporaryDirectory(prefix='voka-gloss-') as cwd:
        schema_path = Path(cwd)/'schema.json'; dump(schema_path,schema)
        for i in range(0,len(words),batch_size):
            batch = words[i:i+batch_size]
            request = prompt+'\nINPUT:\n'+json.dumps(batch,ensure_ascii=False)+'\n'
            stem = folder/f'{i//batch_size:02d}'
            request_hash = hashlib.sha256(request.encode()).hexdigest()
            meta_path = stem.with_suffix('.meta.json')
            if meta_path.exists():
                meta=json.loads(meta_path.read_text())
                if meta['request_sha256'] != request_hash: raise ValueError('Cache input changed; use a fresh output directory')
                if meta['returncode'] == 0 and (stem.with_suffix('.json').exists() or meta.get('parse_error')):
                    if stem.with_suffix('.json').exists():
                        json.loads(stem.with_suffix('.json').read_text())
                    continue
            stem.with_suffix('.prompt.txt').write_text(request)
            started=time.monotonic()
            if model in OPENCODE_MODELS:
                # OpenCode has no JSON Schema flag; the shared prompt still asks for bare JSON.
                command = ['opencode','run','--format','json','-m',model]
                with stem.with_suffix('.events.jsonl').open('w') as events, stem.with_suffix('.stderr.txt').open('w') as stderr:
                    proc=subprocess.run(command,input=request,text=True,stdout=events,stderr=stderr,cwd=cwd,timeout=600)
                answer = opencode_answer(stem.with_suffix('.events.jsonl'))
                stem.with_suffix('.answer.txt').write_text(answer)
                meta={'model':model,'runner':'opencode','cli_version':cli_version('opencode'),'batch':i//batch_size,'count':len(batch),'request_sha256':request_hash,'command':command,'seconds':round(time.monotonic()-started,3),'returncode':proc.returncode,'output_sha256':hashlib.sha256(answer.encode()).hexdigest()}
                if proc.returncode == 0:
                    try:
                        data = json.loads(answer)
                        if not isinstance(data,dict) or not isinstance(data.get('words'),list):
                            raise ValueError('answer must be an object with a words array')
                    except (json.JSONDecodeError, ValueError) as error:
                        meta['parse_error'] = str(error)
                    else:
                        dump(stem.with_suffix('.json'),data)
            else:
                command = ['codex','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-m',model,'-c','model_reasoning_effort="low"','--json','--output-schema',str(schema_path),'-o',str(stem.with_suffix('.json')),'-']
                with stem.with_suffix('.events.jsonl').open('w') as events, stem.with_suffix('.stderr.txt').open('w') as stderr:
                    proc=subprocess.run(command,input=request,text=True,stdout=events,stderr=stderr,cwd=cwd,timeout=600)
                meta={'model':model,'runner':'codex','cli_version':cli_version('codex'),'batch':i//batch_size,'count':len(batch),'request_sha256':request_hash,'command':command,'seconds':round(time.monotonic()-started,3),'returncode':proc.returncode}
            dump(meta_path,meta)
            print(model,i//batch_size,meta['seconds'],proc.returncode,flush=True)
            if proc.returncode: raise RuntimeError(f'CLI failed; see {stem}.stderr.txt')
            if meta.get('parse_error'): print(f'{model} {i//batch_size}: invalid JSON answer: {meta["parse_error"]}',flush=True)

def compare():
    words=json.loads((OUT/'sample.json').read_text())['words']
    results={}; stats={}
    for model in MODELS:
        folder=OUT/model_dir(model)
        by_lemma={}; duplicates=set(); usage={}; seconds=0
        for path in sorted(folder.glob('[0-9][0-9].json')):
            data=json.loads(path.read_text())
            for value in data['words']:
                lemma=value.get('lemma')
                if lemma in by_lemma: duplicates.add(lemma)
                by_lemma[lemma]=value
        for path in sorted(folder.glob('*.events.jsonl')):
            for line in path.read_text().splitlines():
                event=json.loads(line)
                if event.get('type')=='turn.completed':
                    for key,value in event.get('usage',{}).items(): usage[key]=usage.get(key,0)+value
                elif event.get('type')=='step_finish':
                    tokens=event.get('part',{}).get('tokens',{})
                    usage['input_tokens']=usage.get('input_tokens',0)+tokens.get('input',0)
                    usage['cached_input_tokens']=usage.get('cached_input_tokens',0)+tokens.get('cache',{}).get('read',0)
                    usage['cache_write_input_tokens']=usage.get('cache_write_input_tokens',0)+tokens.get('cache',{}).get('write',0)
                    usage['output_tokens']=usage.get('output_tokens',0)+tokens.get('output',0)
                    usage['reasoning_output_tokens']=usage.get('reasoning_output_tokens',0)+tokens.get('reasoning',0)
                    usage['cost_usd']=round(usage.get('cost_usd',0)+event.get('part',{}).get('cost',0),6)
        for path in folder.glob('*.meta.json'): seconds+=json.loads(path.read_text())['seconds']
        errors={w['lemma']:validate(w,by_lemma.get(w['lemma'])) for w in words}
        for lemma in duplicates:
            if lemma in errors: errors[lemma].append('duplicate word')
        extras=sorted(set(by_lemma)-{w['lemma'] for w in words})
        results[model]=(by_lemma,errors)
        stats[model]={'format_invalid_words':sum(bool(e) for e in errors.values()),'unexpected_lemmas':extras,'by_level':{level:{'words':sum(w['level']==level for w in words),'format_invalid':sum(bool(errors[w['lemma']]) for w in words if w['level']==level)} for level in LEVELS+['Unleveled']},'seconds':round(seconds,3),'usage':usage,'errors':{k:v for k,v in errors.items() if v}}
    def display(value):
        if not value: return ''
        try:
            return value['lemma']+'　'+'　'.join(LABELS.get(g['pos'],g['pos'])+' '+'；'.join(g['senses']) for g in value['glosses'])
        except (KeyError, TypeError):
            return json.dumps(value, ensure_ascii=False)
    columns=['lemma','level','POS','OEWN sense summary','cheap-model gloss','mid-model gloss','deepseek-model gloss','cheap format-valid','mid format-valid','deepseek format-valid','cheap_ok (Y/N)','mid_ok (Y/N)','deepseek_ok (Y/N)','notes']
    rows=[]
    for w in words:
        row=[w['lemma'],w['level'],', '.join(LABELS.get(p,p) for p in w['pos']),' | '.join(LABELS.get(p,p)+' '+'; '.join(w['oewn'][p]) for p in w['pos'])]
        row += [display(results[m][0].get(w['lemma'])) for m in MODELS]
        row += ['N' if results[m][1][w['lemma']] else 'Y' for m in MODELS]
        rows.append(row+['','','',''])
    with (OUT/'comparison.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.writer(f,lineterminator="\n"); writer.writerow(columns); writer.writerows(rows)
    escape=lambda x: x.replace('|','\\|').replace('\n',' ')
    (OUT/'comparison.md').write_text('# 母语释义试点对比\n\n300 words; human scores intentionally blank. See [method and limitations](README.md).\n\n'+'| '+' | '.join(columns)+' |\n|'+'|'.join(['---']*len(columns))+'|\n'+''.join('| '+' | '.join(escape(x) for x in row)+' |\n' for row in rows))
    dump(OUT/'stats.json',stats)
    print(json.dumps(stats,ensure_ascii=False,indent=2))

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('action',choices=['sample','generate','compare']); parser.add_argument('--model',choices=MODELS); parser.add_argument('--batch-size',type=int,default=25); args=parser.parse_args()
    if args.action=='sample': sample()
    elif args.action=='generate':
        if not args.model: parser.error('--model required')
        if not 1<=args.batch_size<=50: parser.error('batch size must be 1..50')
        generate(args.model,args.batch_size)
    else: compare()
