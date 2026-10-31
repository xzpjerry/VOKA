#!/usr/bin/env python3
"""Disposable Anki v1 probe. Fixed to isolated port 8766; never syncs.
Run: python3 tools/review_anki_v1.py --output docs/research/anki-v1-raw.json
Requires the isolated Anki instance and its default ~/VOKA-anki-test collection.
"""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
import urllib.request

URL = 'http://127.0.0.1:8766/api/v1'
DB = Path.home() / 'VOKA-anki-test/User 1/collection.anki2'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
log = {'endpoint': URL, 'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'calls': [], 'scm': []}

def save():
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(log, ensure_ascii=False, indent=2) + '\n')

def call(label, method, params, allow_error=False):
    request = dict(jsonrpc='2.0', id=len(log['calls']) + 1, method=method, params=json.loads(json.dumps(params)))
    req = urllib.request.Request(URL, json.dumps(request).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read().decode()
    body = json.loads(raw)
    log['calls'].append(dict(label=label, request=request, rawResponse=raw, response=body))
    save()
    if 'error' in body and not allow_error:
        raise RuntimeError(body)
    return body.get('result', body)

def scm():
    time.sleep(0.3)
    with tempfile.TemporaryDirectory(prefix='voka-scm-') as directory:
        dest = Path(directory) / DB.name
        Path(str(dest) + '-shm').unlink(missing_ok=True)
        shutil.copy2(DB, dest)
        wal = Path(str(DB) + '-wal')
        if wal.exists():
            shutil.copy2(wal, str(dest) + '-wal')
        with sqlite3.connect(dest) as connection:
            return connection.execute('select scm from col').fetchone()[0]

def measured(label, method, params):
    before = scm()
    result = call(label, method, params)
    after = scm()
    log['scm'].append(dict(label=label, before=before, after=after, changed=before != after))
    save()
    return result

stamp = str(time.time_ns())
name = 'VOKA v1 review ' + stamp
models, decks = [], []
try:
    description = call('describe', 'api.describe', {})
    # Keep runtime contract, including completion metadata, as evidence.
    config = dict(name=name, fields=[{'name': 'Key'}, {'name': 'Word'}, {'name': 'Keep'}],
                  templates=[dict(name='Card', questionHtml='{{Key}}', answerHtml='{{Word}} {{Keep}}')], css='.card { color: black; }')
    model = measured('create_type', 'noteTypes.create', config)
    print('create_type', model)
    ref = {'name': name}
    models.append(ref)
    for suffix in [' A', ' B']:
        deck = {'name': name + suffix}
        call('create_deck' + suffix, 'decks.create', deck)
        decks.append(deck)
    second = dict(config, name=name + ' other')
    call('create_other_type', 'noteTypes.create', second)
    other = {'name': second['name']}
    models.append(other)

    def note(key, deck=None, model=None, duplicates=None):
        item = dict(noteType=model or ref, deck=deck or decks[0], fields=dict(Key=key, Word='original', Keep='preserved'))
        if duplicates is not None:
            item['duplicates'] = duplicates
        return item

    seed = call('seed', 'notes.createMany', {'notes': [note('en:achieve')]})
    # Search instead of assuming a create result shape.
    found = call('seed_search', 'notes.search', {'query': '"note:' + name + '"'})
    print('seed_search', found)
    ids = found['ids']
    cases = [('new', note('en:new')), ('exact', note('en:achieve')),
             ('case', note('En:Achieve')), ('html', note('<b>en:achieve</b>')),
             ('other_deck_default', note('en:achieve', decks[1])),
             ('deck_scope_other', note('en:achieve', decks[1], duplicates={'scope': 'deck', 'deck': decks[1]})),
             ('deck_scope_same', note('en:achieve', duplicates={'scope': 'deck', 'deck': decks[0]})),
             ('other_type_default', note('en:achieve', model=other)),
             ('across_types', note('en:achieve', model=other, duplicates={'acrossNoteTypes': True}))]
    for label, item in cases:
        call('validate_' + label, 'notes.validateMany', {'notes': [item]})
    call('invalid_scope', 'notes.validateMany', {'notes': [note('en:achieve', duplicates={'scope': 'invalid'})]}, True)
    batch = [note('en:batch-one'), note('en:achieve'), note('en:batch-two')]
    call('non_atomic', 'notes.createMany', {'notes': batch, 'atomic': False})
    call('after_non_atomic', 'notes.getMany', {'ids': call('search_non_atomic', 'notes.search', {'query': '"note:' + name + '"'})['ids']})
    # Remove successful batch notes, so atomic=true sees exactly the same initial state.
    batch_ids = call('search_batch', 'notes.search', {'query': '"note:' + name + '" Key:en:batch-*'})['ids']
    call('reset_batch', 'notes.delete', {'ids': batch_ids})
    call('atomic', 'notes.createMany', {'notes': batch, 'atomic': True}, True)
    call('after_atomic', 'notes.getMany', {'ids': call('search_atomic', 'notes.search', {'query': '"note:' + name + '"'})['ids']})
    measured('update_css', 'noteTypes.update', {'noteType': ref, 'patch': {'css': '.card { color: blue; }'}})
    renamed = name + ' renamed'
    measured('update_name', 'noteTypes.update', {'noteType': ref, 'patch': {'name': renamed}})
    ref['name'] = renamed
    call('before_merge', 'notes.getMany', {'ids': ids})
    measured('update_note', 'notes.update', {'id': ids[0], 'patch': {'fields': {'Word': 'changed'}}})
    call('after_merge', 'notes.getMany', {'ids': ids})
    measured('add_tag', 'tags.add', {'noteIds': ids, 'tags': ['voka-v1-review']})
    measured('add_field', 'noteTypes.editStructure', {'noteType': ref, 'edits': [{'op': 'addField', 'field': {'name': 'Extra'}}]})
    handle = call('navigate', 'application.navigate', {'view': 'deckBrowser'})
    print('navigate', handle)
    operation_id = handle['operationId']
    for attempt in range(100):
        operation = call('operation_' + str(attempt), 'operations.get', {'operationId': operation_id})
        if operation.get('state') in ('succeeded', 'failed', 'cancelled', 'completed'):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError('Operation did not finish within polling budget')
    assert operation['state'] == 'succeeded', operation
finally:
    for model_ref in models:
        remaining = call('cleanup_search', 'notes.search', {'query': '"note:' + model_ref['name'] + '"'})
        call('cleanup_notes', 'notes.delete', {'ids': remaining['ids']})
    if decks:
        call('cleanup_decks', 'decks.delete', {'decks': decks, 'deleteCards': True})
    if models:
        call('cleanup_types', 'noteTypes.deleteUnused', {'noteTypes': models})
    save()
