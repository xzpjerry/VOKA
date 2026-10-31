import csv
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('pilot', Path(__file__).with_name('pilot.py'))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)

class PilotTests(unittest.TestCase):
    def test_reproducible_strata_and_polysemy(self):
        path = pilot.OUT/'sample.json'
        before = path.read_bytes()
        pilot.sample()
        self.assertEqual(before,path.read_bytes())
        words = json.loads(before)['words']
        self.assertEqual(len({w['lemma'] for w in words}),300)
        self.assertTrue(all(set(w['pos']) <= {'n','v','a','r'} for w in words))
        lead=next(w for w in words if w['lemma']=='lead')
        self.assertEqual(len(lead['oewn']['n']),4)
        for level in pilot.LEVELS:
            self.assertEqual(sum(w['level']==level for w in words),40)
        self.assertEqual(sum(w['level']=='Unleveled' for w in words),60)
        self.assertTrue({'light','present','lead','bank','run'} <= {w['lemma'] for w in words})

    def test_reject_format_violations(self):
        word={'lemma':'light','pos':['n','v']}
        good={'lemma':'light','glosses':[{'pos':'n','senses':['光','灯']},{'pos':'v','senses':['点燃']}]}
        self.assertEqual(pilot.validate(word,good),[])
        for senses in [[],['一二三四五六七八九十百'],['光;灯'],['light'],['光','光'],['甲','乙','丙','丁']]:
            bad=json.loads(json.dumps(good)); bad['glosses'][0]['senses']=senses
            self.assertTrue(pilot.validate(word,bad),senses)
        bad=json.loads(json.dumps(good)); bad['glosses'][1]['pos']='n'
        self.assertTrue(pilot.validate(word,bad))
        self.assertTrue(pilot.validate(word,None))

    def test_model_directories(self):
        self.assertEqual(pilot.model_dir('gpt-6-luna'),'gpt-6-luna')
        self.assertEqual(pilot.model_dir('opencode/deepseek-v4.1-flash-free'),'deepseek-v4.1-flash-free')
        self.assertNotIn('/',pilot.model_dir('opencode/deepseek-v4.1-flash-free'))

    def test_opencode_answer_concatenates_text_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'00.events.jsonl'
            path.write_text('\n'.join([
                json.dumps({'type':'step_start','part':{'type':'step-start'}}),
                json.dumps({'type':'text','part':{'text':'{"words":'}}),
                json.dumps({'type':'text','part':{'text':'[]}'}}),
                json.dumps({'type':'step_finish','part':{'tokens':{}}}),
            ])+'\n')
            self.assertEqual(pilot.opencode_answer(path),'{"words":[]}')

if __name__=='__main__': unittest.main()
