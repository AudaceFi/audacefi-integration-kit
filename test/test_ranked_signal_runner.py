from contextlib import redirect_stderr, redirect_stdout
import importlib.util
from io import BytesIO, StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "ranked-signal.py"
SPEC = importlib.util.spec_from_file_location("ranked_signal_example", EXAMPLE)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)

VALIDATION_SCOPE = "a" * 64
OFFICIAL_SCOPE = "b" * 64
SIGNAL_IDS = ("synthetic-long-0001", "synthetic-flat-0002")


class RecordedInput(BytesIO):
    def close(self):
        if not self.closed:
            self.sent = self.getvalue()
        super().close()


class SyntheticGateway:
    def __init__(self, ready, *, complete=False):
        responses = [ready]
        if complete:
            responses += [dict(status="ranked", ranked=True, simulatedFeeBps=20, positionAfterRaw=position,
                               signalId=identity, sequence=sequence)
                          for sequence, (identity, position) in enumerate(zip(SIGNAL_IDS, ("100", "0")), 1)]
        self.stdout = BytesIO(b"".join(json.dumps(response).encode() + b"\n" for response in responses))
        self.stdin = RecordedInput()
        self.returncode = 0

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        self.stdout.close()

    def wait(self, timeout=None):
        return self.returncode


class RankedRunnerTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory())) / "run"
        self.directory.mkdir(mode=0o700)

    def run_example(self, child, *, target=None):
        args = [str(EXAMPLE), "--operator", str(self.directory / "operator.mjs"), "--run-dir", str(self.directory),
                "--symbol", "TEST", "--target-bps", "2"]
        if target is not None:
            args += ["--target", target]
        with (patch.object(sys, "argv", args), patch.object(RUNNER.subprocess, "Popen", return_value=child) as spawn,
              patch.object(RUNNER.uuid, "uuid4", side_effect=SIGNAL_IDS),
              redirect_stdout(StringIO())):
            result = RUNNER.main()
            self.assertIn("--emit-ready-scope", spawn.call_args.args[0])
            return result

    def test_same_scope_restart_sends_exact_saved_signal_bytes(self):
        ready = {"status": "ready", "runScope": VALIDATION_SCOPE}
        first = SyntheticGateway(ready, complete=True)
        self.assertEqual(self.run_example(first), 0)
        saved = [(self.directory / f"{side}.json").read_bytes().removesuffix(b"\n").decode("utf-8")
                 for side in ("long", "flat")]
        frames = [json.loads(line) for line in first.stdin.sent.splitlines()]
        self.assertEqual(frames, [{"runScope": VALIDATION_SCOPE, "signal": signal} for signal in saved])
        restarted = SyntheticGateway(ready, complete=True)
        self.assertEqual(self.run_example(restarted), 0)
        self.assertEqual(restarted.stdin.sent, first.stdin.sent)
        self.assertEqual((self.directory / "run-scope").read_bytes(), VALIDATION_SCOPE.encode() + b"\n")

    def test_cross_target_restart_never_sends_or_replaces_saved_state(self):
        first = SyntheticGateway({"status": "ready", "runScope": VALIDATION_SCOPE}, complete=True)
        self.assertEqual(self.run_example(first), 0)
        before = {path.name: path.read_bytes() for path in self.directory.iterdir()}
        switched = SyntheticGateway({"status": "ready", "runScope": OFFICIAL_SCOPE})
        with self.assertRaisesRegex(ValueError, "another gateway scope"):
            self.run_example(switched, target="official")
        self.assertEqual(switched.stdin.sent, b"")
        self.assertEqual({path.name: path.read_bytes() for path in self.directory.iterdir()}, before)

    def test_saved_legs_without_a_scope_require_review(self):
        (self.directory / "long.json").write_bytes(b"existing signal\n")
        ready = SyntheticGateway({"status": "ready", "runScope": VALIDATION_SCOPE})
        with self.assertRaisesRegex(ValueError, "no verified run scope"):
            self.run_example(ready)
        self.assertEqual(ready.stdin.sent, b"")
        self.assertFalse((self.directory / "run-scope").exists())
        self.assertEqual((self.directory / "long.json").read_bytes(), b"existing signal\n")

    def test_unscoped_ready_response_never_persists_or_sends_a_signal(self):
        ready = SyntheticGateway({"status": "ready"})
        with self.assertRaisesRegex(RuntimeError, "did not provide its run scope"):
            self.run_example(ready)
        self.assertEqual(ready.stdin.sent, b"")
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_manual_review_reports_the_matching_operation_key(self):
        signal = json.dumps({"id": SIGNAL_IDS[0], "sequence": 1}).encode() + b"\n"
        result = {"status": "review-required", "signalId": SIGNAL_IDS[0], "sequence": 1, "operationKey": "c" * 64}
        gateway = SyntheticGateway({"status": "ready", "runScope": VALIDATION_SCOPE})
        errors = StringIO()
        with (patch.object(RUNNER, "read_response", return_value=result), redirect_stderr(errors),
              self.assertRaisesRegex(RuntimeError, "operator review")):
            RUNNER.wait_for_rank(gateway, None, signal, VALIDATION_SCOPE, 1)
        self.assertIn(result["operationKey"], errors.getvalue())

    def test_partial_marker_fails_closed(self):
        marker = self.directory / "run-scope"
        marker.write_bytes(b"a" * 32)
        marker.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "another gateway scope"):
            RUNNER.bind_run_scope(self.directory, VALIDATION_SCOPE)
        self.assertEqual(marker.read_bytes(), b"a" * 32)

    def test_linked_marker_fails_closed(self):
        valid = self.directory / "valid"
        valid.write_bytes(VALIDATION_SCOPE.encode() + b"\n")
        valid.chmod(0o600)
        try:
            (self.directory / "run-scope").symlink_to(valid)
        except OSError as error:
            self.skipTest(f"Symbolic links are unavailable: {error}")
        with self.assertRaisesRegex(ValueError, "marker is unsafe"):
            RUNNER.bind_run_scope(self.directory, VALIDATION_SCOPE)

    def test_linked_signal_never_reaches_the_gateway(self):
        RUNNER.bind_run_scope(self.directory, VALIDATION_SCOPE)
        original = self.directory / "elsewhere.json"
        original.write_bytes(b"ignored signal\n")
        original.chmod(0o600)
        try:
            (self.directory / "long.json").symlink_to(original)
        except OSError as error:
            self.skipTest(f"Symbolic links are unavailable: {error}")
        gateway = SyntheticGateway({"status": "ready", "runScope": VALIDATION_SCOPE})
        with self.assertRaisesRegex(ValueError, "saved signal file is unsafe"):
            self.run_example(gateway)
        self.assertEqual(gateway.stdin.sent, b"")

    def test_rejected_bindings_send_no_bytes_to_a_real_synthetic_subprocess(self):
        program = ("from pathlib import Path\nimport sys\n"
                   "print(sys.argv[1], flush=True)\n"
                   "Path(sys.argv[2]).write_bytes(sys.stdin.buffer.read())\n")
        launch = RUNNER.subprocess.Popen
        ready = json.dumps({"status": "ready", "runScope": OFFICIAL_SCOPE})
        for name, existing in (("wrong-scope", "run-scope"), ("missing-scope", "long.json")):
            with self.subTest(name=name):
                run = self.directory / name
                run.mkdir(mode=0o700)
                saved = run / existing
                saved.write_bytes(VALIDATION_SCOPE.encode() + b"\n")
                saved.chmod(0o600)
                capture = self.directory / f"{name}.bytes"
                args = [str(EXAMPLE), "--operator", str(run / "operator.mjs"), "--run-dir", str(run),
                        "--target", "official", "--symbol", "TEST", "--target-bps", "2"]

                def synthetic_child(command, **options):
                    self.assertEqual(command[-3:], ["--emit-ready-scope", "--target", "official"])
                    return launch([sys.executable, "-I", "-B", "-c", program, ready, str(capture)], **options)

                with (patch.object(sys, "argv", args), patch.object(RUNNER.subprocess, "Popen", synthetic_child),
                      self.assertRaises(ValueError)):
                    RUNNER.main()
                self.assertEqual(capture.read_bytes(), b"")
                self.assertEqual(list(run.iterdir()), [saved])


if __name__ == "__main__":
    unittest.main()
