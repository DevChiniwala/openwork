import importlib.util
import json
import io
import types
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('desktop_bridge', Path(__file__).with_name('desktop-bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class DesktopPrivilegeBoundary(unittest.TestCase):
    def test_model_shell_drops_privileges_and_does_not_inherit_host_credentials(self):
        with patch.object(bridge.os, 'geteuid', return_value=0), patch.object(bridge.os, 'execve') as execute, patch.object(bridge.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(b'{"command":"id -un"}'))):
            # execve replaces the process; the sentinel prevents subsequent route dispatch in the test.
            execute.side_effect = SystemExit
            with self.assertRaises(SystemExit):
                bridge.main(['command'])
            program, argv, env = execute.call_args.args
            self.assertEqual(program, '/usr/sbin/runuser')
            self.assertEqual(argv[1:4], ['-u', 'openwork-command', '--'])
            self.assertEqual(env['HOME'], '/home/openwork-command')
            self.assertEqual(set(env), {'PATH', 'HOME', 'LANG', 'WORKBOT_COMMAND'})

    def test_rejects_commands_destinations_and_extra_arguments(self):
        for args in [['sh', '-c', 'id'], ['call', 'http://example.com'], ['call', '/health', 'extra'],
                     ['start', '/workspace/guest.mjs'], ['call', '/../../tokens'], ['call', '/token']]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                bridge.arguments(args)

    def test_mismatched_image_never_runs_uploaded_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'guest.mjs').write_text('trusted image guest')
            (root / 'start.sh').write_text('trusted image startup')
            (root / 'guest.version').write_text('trusted image version')
            with patch.object(bridge, 'ROOT', root), patch.object(bridge.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'out of date'):
                    bridge.start('0' * 64)
                run.assert_not_called()

    def test_only_fixed_loopback_destination_and_private_bearer_are_used(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'token').write_text('fixture-bearer')
            with patch.object(bridge, 'STATE', state), patch.object(bridge.http.client, 'HTTPConnection') as connect:
                response = connect.return_value.getresponse.return_value
                response.status = 200
                response.read.return_value = b'{"ok":true}'
                self.assertEqual(bridge.call('/health', '{}'), {'ok': True})
                connect.assert_called_once_with('127.0.0.1', 6080, timeout=2)
                self.assertNotIn('fixture-bearer', json.dumps(bridge.call('/health', '{}')))



class MemberFilesFolder(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.base = Path(self.directory.name)
        (self.base / 'browser').mkdir()
        (self.base / 'out').mkdir()
        account = lambda name: types.SimpleNamespace(pw_uid=bridge.os.getuid(), pw_gid=bridge.os.getgid(), pw_dir=str(self.base / 'browser'))
        self.patches = [
            patch.object(bridge, 'FILES_ROOT', self.base / 'files'),
            patch.object(bridge, 'WORKSPACE_OUT', self.base / 'out'),
            patch.object(bridge.pwd, 'getpwnam', side_effect=account),
            patch.object(bridge.grp, 'getgrnam', return_value=types.SimpleNamespace(gr_gid=bridge.os.getgid())),
            patch.object(bridge.subprocess, 'run'),
        ]
        for started in self.patches:
            started.start()

    def tearDown(self):
        for started in self.patches:
            started.stop()
        self.directory.cleanup()

    def test_on_makes_a_shared_files_folder_and_points_downloads_into_it_and_off_points_them_back(self):
        self.assertEqual(bridge.member_files('on'), {'ok': True, 'files': 'on'})
        self.assertTrue((self.base / 'files' / 'Downloads').is_dir())
        self.assertEqual(oct((self.base / 'files').stat().st_mode & 0o7777), '0o2770')
        self.assertEqual(bridge.os.readlink(self.base / 'browser' / 'Downloads'), str(self.base / 'files' / 'Downloads'))
        self.assertEqual(bridge.member_files('on'), {'ok': True, 'files': 'on'}, 'idempotent')
        bridge.member_files('off')
        self.assertEqual(bridge.os.readlink(self.base / 'browser' / 'Downloads'), str(self.base / 'out'))

    def test_a_link_planted_where_downloads_belongs_is_refused_and_a_real_folder_is_kept(self):
        (self.base / 'files').mkdir()
        (self.base / 'files' / 'Downloads').symlink_to(self.base / 'browser')
        with self.assertRaises(OSError):
            bridge.member_files('on')
        (self.base / 'files' / 'Downloads').unlink()
        (self.base / 'browser' / 'Downloads').mkdir()
        bridge.member_files('on')
        self.assertFalse((self.base / 'browser' / 'Downloads').is_symlink())

    def test_only_on_and_off_are_accepted(self):
        self.assertEqual(bridge.arguments(['files', 'on']), ('files', 'on'))
        for args in [['files'], ['files', '/etc'], ['files', 'on', 'extra']]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                bridge.arguments(args)


if __name__ == '__main__':
    unittest.main()
