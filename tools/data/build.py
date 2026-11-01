#!/usr/bin/env python3
"""Pinned offline English packs. Python 3.10+, standard library only."""
import csv, gzip, hashlib, io, json, pathlib, re, urllib.request, unicodedata, zipfile
import xml.etree.ElementTree as ET
ROOT = pathlib.Path(__file__).resolve().parents[2]
CACHE = ROOT / '.cache/data'
OUT = ROOT / 'public/data'
VERSION, DATE = 'en-2026.10', '2026-10-31'
LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

def norm(s):
    return unicodedata.normalize('NFC', s.lower()).replace('’', "'").replace('‘', "'")

def single(s):
    return bool(s) and not re.search(r'[\s_]', s)

def download(item):
    path = CACHE / item['name']
    if not path.exists():
        print('Download', item['url'])
        with urllib.request.urlopen(item['url'], timeout=120) as response:
            path.write_bytes(response.read())
    content = path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if digest != item['sha256']:
        raise ValueError(f"Checksum mismatch: {item['name']}: {digest}")
    return content

def build():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    lock = json.loads((ROOT / 'tools/data/sources.json').read_text())
    sources = {x['name']: download(x) for x in lock}
    meta = {x['name']: x for x in lock}
    sizes = {}
    def pack(name, entries, source_names, license, version, attribution, **extra):
        data = dict(source=[meta[n]['url'] for n in source_names], license=license,
                    version=version, generatedDate=DATE, dataVersion=VERSION,
                    entryCount=extra.pop('entryCount', len(entries)), attribution=attribution, entries=entries, **extra)
        raw = (json.dumps(data, ensure_ascii=False, separators=(',', ':'), sort_keys=True)+'\n').encode()
        (OUT / name).write_bytes(raw)
        sizes[name] = dict(raw=len(raw), gzip=len(gzip.compress(raw, mtime=0)))
        print(name, data['entryCount'], 'entries;', sizes[name])
        return {k:v for k,v in data.items() if k != 'entries'}
    attributions = []
    # Official 1.6 ALL sheet retains slash variants; ALL_sep would lose canonical spellings.
    z = zipfile.ZipFile(io.BytesIO(sources['cefrj.zip']))
    x = zipfile.ZipFile(io.BytesIO(z.read('CEFR-J Wordlist Ver1.6.xlsx')))
    ns = {'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    strings = [''.join(t.text or '' for t in s.findall('.//m:t', ns))
               for s in ET.fromstring(x.read('xl/sharedStrings.xml'))]
    rows = []
    for row in ET.fromstring(x.read('xl/worksheets/sheet2.xml')).findall('.//m:row', ns)[1:]:
        cells = {}
        for c in row:
            value = c.findtext('m:v', '', ns)
            cells[re.sub(r'\d', '', c.attrib['r'])] = strings[int(value)] if c.attrib.get('t') == 's' and value else value
        rows.append((cells.get('A',''), cells.get('C','')))
    octrows = [(r['headword'],r['CEFR']) for r in csv.DictReader(io.StringIO(sources['octanove.csv'].decode('utf-8-sig')))]
    def levels(rows):
        entries = {}
        for headword, level in rows:
            variants = list(dict.fromkeys(norm(w.strip()) for w in headword.split('/')))
            if not variants or not all(single(v) for v in variants) or level not in LEVELS:
                continue
            lemma = variants[0]
            e = entries.setdefault(lemma, [level, []])
            e[0] = min(e[0], level, key=LEVELS.index)
            e[1] = sorted(set(e[1] + [v for v in variants[1:] if v != lemma]))
        return entries
    cefr, octa = levels(rows), levels(octrows)
    attributions.append(pack('cefrj.json', cefr, ['cefrj.zip'], 'CEFR-J attribution terms (not SPDX)', '1.6',
        'The CEFR-J Wordlist Version 1.6. Compiled by Yukio Tono, Tokyo University of Foreign Studies. Retrieved from https://www.cefr-j.org/download.html on 31/10/2026. Copyright Tono Laboratory, TUFS. Modified: normalized, merged POS, removed multiword headwords; first slash spelling retained.', licenseUrl='https://www.cefr-j.org/download.html'))
    attributions.append(pack('octanove.json', octa, ['octanove.csv'], 'CC-BY-SA-4.0', '1.0',
        'Octanove Vocabulary Profile C1/C2 1.0, Octanove Labs. Modified: normalized, merged POS, removed multiword headwords; first slash spelling retained. Adapted data distributed under CC BY-SA 4.0.', licenseUrl='https://creativecommons.org/licenses/by-sa/4.0/'))
    merged = dict(cefr)
    for lemma,(level,variants) in octa.items():
        if lemma not in merged: merged[lemma] = [level,variants]
        else: merged[lemma] = [min(merged[lemma][0],level,key=LEVELS.index),sorted(set(merged[lemma][1]+variants))]
    for lemma, (_, variants) in list(merged.items()):
        for variant in variants:
            if variant != lemma and variant in merged:
                merged[lemma] = [min(merged[lemma][0], merged[variant][0], key=LEVELS.index), sorted(set(merged[lemma][1] + [variant] + merged[variant][1]))]
                del merged[variant]
    print('Lowest-level counts:', {level:sum(e[0]==level for e in merged.values()) for level in LEVELS})
    z = zipfile.ZipFile(io.BytesIO(sources['oewn-json.zip']))
    synsets = {}
    for name in sorted(z.namelist()):
        if not name.startswith('entries-') and name.endswith('.json'):
            synsets.update(json.loads(z.read(name)))
    dictionary, fallback = {}, {}
    for name in sorted(z.namelist()):
        if not name.startswith('entries-'): continue
        for word, poses in json.loads(z.read(name)).items():
            lemma = norm(word)
            if not single(lemma): continue
            result = dictionary.setdefault(lemma,{})
            for pos, entry in poses.items():
                pos = 'a' if pos == 's' else pos
                glosses = result.setdefault(pos, [])
                for sense in entry.get('sense',[]):
                    for gloss in synsets[sense['synset']]['definition']:
                        if gloss not in glosses and len(glosses)<2: glosses.append(gloss)
                # US only; unmarked pronunciations cannot safely be labelled US.
                for p in entry.get('pronunciation',[]):
                    if p.get('variety') == 'US': fallback.setdefault(lemma,{}).setdefault(pos,p['value'])
    attributions.append(pack('oewn.json', dictionary, ['oewn-json.zip'], 'CC-BY-4.0; Princeton WordNet notice', '2025',
        'Open English WordNet Team, Open English WordNet 2025. Modified: single-word normalized lemmas, maximum two definitions per POS. Includes Princeton WordNet material; see notices.', licenseUrl='https://creativecommons.org/licenses/by/4.0/'))
    phones = dict(zip('AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH'.split(),
                       'ɑ æ ʌ ɔ aʊ aɪ b tʃ d ð ɛ ɝ eɪ f ɡ h ɪ i dʒ k l m n ŋ oʊ ɔɪ p ɹ s ʃ t θ ʊ u v w j z ʒ'.split()))
    def ipa(tokens):
        parts=[]
        for token in tokens:
            phone=token.rstrip('012'); stress=token[len(phone):]
            value=phones[phone]
            if phone=='AH' and stress=='0': value='ə'
            if phone=='ER' and stress=='0': value='ɚ'
            parts.append(('ˈ' if stress=='1' else 'ˌ' if stress=='2' else '')+value)
        return '/'+''.join(parts)+'/'
    readings={}
    for line in sources['cmudict.dict'].decode().splitlines():
        if not line or line.startswith(';;;'): continue
        word,*tokens=line.split('#')[0].split()
        lemma=norm(re.sub(r'\(\d+\)$','',word))
        if single(lemma): readings.setdefault(lemma,ipa(tokens))
    attributions.append(pack('readings.json', readings, ['cmudict.dict'], 'BSD-2-Clause (CMU)', '74790861f652b15e4ac49015a90074ad62a27690',
        'Carnegie Mellon University, CMU Pronouncing Dictionary. Modified: ARPAbet converted to broad US IPA, first pronunciation retained. CMUdict does not label POS; alternate numbered pronunciations are not POS labels.', licenseUrl='https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/LICENSE'))
    attributions.append(pack('oewn-readings.json', fallback, ['oewn-json.zip'], 'CC-BY-4.0; Princeton WordNet notice', '2025',
        'Open English WordNet Team, 2025. US-labelled pronunciations only, grouped by POS; fallback where CMUdict has no entry.', licenseUrl='https://creativecommons.org/licenses/by/4.0/'))
    exceptions={}
    z=zipfile.ZipFile(io.BytesIO(sources['oewn-wndb.zip']))
    for name in sorted(z.namelist()):
        if not name.endswith('.exc'): continue
        pos={'noun':'n','verb':'v','adj':'a','adv':'r'}[pathlib.PurePosixPath(name).stem]
        result=exceptions.setdefault(pos,{})
        for line in z.read(name).decode().splitlines():
            form,*lemmas=line.split()
            if single(form): result[norm(form)]=[norm(w) for w in lemmas if single(w)]
    rules={'n':[['s',''],['ses','s'],['ves','f'],['xes','x'],['zes','z'],['ches','ch'],['shes','sh'],['men','man'],['ies','y']],
           'v':[['s',''],['ies','y'],['es','e'],['es',''],['ed','e'],['ed',''],['ing','e'],['ing','']],
           'a':[['er',''],['est',''],['er','e'],['est','e']]}
    attributions.append(pack('morphology.json', exceptions, ['oewn-wndb.zip'], 'CC-BY-4.0; Princeton WordNet notice', '2025',
        'WordNet irregular exception lists and Morphy suffix rules; normalized and removed multiword forms. Princeton University WordNet notice retained in notices.', rules=rules, entryCount=sum(len(forms) for forms in exceptions.values()), licenseUrl='https://wordnet.princeton.edu/license-and-commercial-use'))
    # Native glosses are generated by tools/gloss/generate.py in a separate,
    # independently versioned pack. Reuse its metadata when present so a data
    # rebuild keeps the About attribution and size record.
    gloss_meta = None
    gloss_path = OUT / 'gloss-zh.json'
    if gloss_path.exists():
        gloss_raw = gloss_path.read_bytes()
        gloss = json.loads(gloss_raw)
        sizes['gloss-zh.json'] = dict(raw=len(gloss_raw), gzip=len(gzip.compress(gloss_raw, mtime=0)))
        gloss_meta = {k: v for k, v in gloss.items() if k not in ('entries', 'missingLemmas', 'generation')}
        gloss_meta['rawBytes'] = sizes['gloss-zh.json']['raw']
        gloss_meta['gzipBytes'] = sizes['gloss-zh.json']['gzip']
        attributions.append(gloss_meta)
    notices={name:sources[name].decode() for name in ['cmu-LICENSE','oewn-LICENSE','princeton-LICENSE']}
    release_version = gloss_meta['dataVersion'] if gloss_meta else VERSION
    (OUT/'attributions.json').write_text(json.dumps(dict(dataVersion=release_version,generatedDate=DATE,packs=attributions,notices=notices),ensure_ascii=False,indent=2)+'\n')
    sizes['attributions.json']=dict(raw=(OUT/'attributions.json').stat().st_size,gzip=len(gzip.compress((OUT/'attributions.json').read_bytes(),mtime=0)))
    (OUT/'sizes.json').write_text(json.dumps(sizes,indent=2)+'\n')
    print('TOTAL',sum(s['raw'] for s in sizes.values()),'raw;',sum(s['gzip'] for s in sizes.values()),'gzip bytes')

if __name__ == '__main__':
    build()
    from level_pos import rebuild, metadata
    rebuild()
    metadata()
