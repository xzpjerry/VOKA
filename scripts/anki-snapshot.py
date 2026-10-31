"""Read-only snapshot from a copy of the isolated collection, including WAL."""
import json, pathlib, shutil, sqlite3, tempfile
source = pathlib.Path.home() / 'VOKA-anki-test/User 1/collection.anki2'
with tempfile.TemporaryDirectory(prefix='voka-import-snapshot-') as directory:
    dest = pathlib.Path(directory) / 'collection.anki2'
    shutil.copy2(source, dest)
    wal = pathlib.Path(str(source) + '-wal')
    if wal.exists():
        shutil.copy2(wal, str(dest) + '-wal')
    with sqlite3.connect(dest) as connection:
        print(json.dumps(dict(scm=connection.execute('select scm from col').fetchone()[0], cards=connection.execute('select id,nid,did,type,queue,due,ivl,factor,reps,lapses,left,odue,odid from cards order by id').fetchall(), revlog=connection.execute('select * from revlog order by id').fetchall())))
