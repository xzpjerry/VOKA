"""Offline regression checks; no provider calls or credentials required."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("generate", Path(__file__).with_name("generate.py"))
generate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generate)


class GeneratorTests(unittest.TestCase):
    def test_codex_effort_is_forwarded(self):
        with tempfile.TemporaryDirectory() as cwd:
            def run(command, **kwargs):
                self.assertEqual(command[command.index("-c") + 1], 'model_reasoning_effort="max"')
                self.assertEqual(kwargs["timeout"], 1800)
                Path(command[command.index("-o") + 1]).write_text('{"words":[]}')
                return SimpleNamespace(stdout="", stderr="", returncode=0)
            with patch.object(generate.subprocess, "run", side_effect=run):
                self.assertFalse(generate.run_cli("prompt", "gpt-6-luna", cwd, 1800, "max")["retryable"])

    def test_resume_preserves_cached_model_and_effort(self):
        batch = [{"lemma": "test", "pos": ["n"]}]
        response = dict(answer='{"words":[]}', seconds=1, returncode=0,
                        stderr="", error_events=[], retryable=False)
        with tempfile.TemporaryDirectory() as cwd, patch.object(generate, "BATCHES", Path(cwd)):
            with patch.object(generate, "run_cli", return_value=response), patch.object(generate, "cli_version", return_value="test"):
                first = generate.generate_one("prompt", "gpt-6-luna", 0, 0, batch, cwd, 1800, 1, 0, "max")
            self.assertEqual(first["record"]["effort"], "max")
            with patch.object(generate, "run_cli", side_effect=AssertionError("must reuse cache")):
                second = generate.generate_one("prompt", "deepseek/deepseek-flash", 0, 0, batch, cwd, 1800, 1, 0)
            self.assertTrue(second["cached"])
            self.assertEqual(second["record"]["model"], "gpt-6-luna")

    def test_format_validator_rejects_missing_pos_long_and_duplicate_senses(self):
        word = dict(lemma="test", pos=["n", "v"])
        result = dict(lemma="test", glosses=[dict(pos="n", senses=["测试", "测试", "这是超过十个汉字长度的释义"])])
        self.assertEqual(set(generate.validate(word, result)), {
            "missing, extra or duplicate POS", "duplicate sense", "sense must be 1..10 Han characters"})

    def test_missing_batches_are_not_format_violations(self):
        with tempfile.TemporaryDirectory() as cwd, patch.object(generate, "BATCHES", Path(cwd)), patch.object(generate, "PROMPT", "prompt", create=True):
            valid, invalid, stats, sources = generate.collect_round(0, [[dict(lemma="test", pos=["n"])]])
        self.assertEqual(stats["unprocessedWords"], 1)
        self.assertEqual(stats["formatInvalidWords"], 0)
        self.assertEqual(invalid, {"test": ["batch result missing"]})

    def test_configuration_label(self):
        self.assertEqual(generate.provenance(dict(model="gpt-6-luna", effort="max")), "gpt-6-luna (effort max)")
        self.assertEqual(generate.provenance(dict(model="deepseek/deepseek-flash")), "deepseek/deepseek-flash")

    def test_progress_ignores_unrelated_cached_requests(self):
        with tempfile.TemporaryDirectory() as cwd, patch.object(generate, "BATCHES", Path(cwd)), patch.object(generate, "RESEARCH", Path(cwd)), patch.object(generate, "PROMPT", "prompt", create=True):
            generate.dump(Path(cwd) / "r0-stale.json", {
                "request_sha256": "old-prompt", "round": 0, "model": "old-model",
            })
            progress = generate.write_progress([dict(lemma="test")], {}, ["test"], {}, 100)
        self.assertEqual(progress["batchesCached"], 0)
        self.assertEqual(progress["batchesRemaining"], 1)
        self.assertEqual(progress["byConfiguration"], {})


if __name__ == "__main__":
    unittest.main()
