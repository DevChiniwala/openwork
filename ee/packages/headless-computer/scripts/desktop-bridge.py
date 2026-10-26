#!/usr/bin/python3 -I
"""The command user's only privileged desktop entry point. All executable inputs are image-owned."""
import fcntl
import grp
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import subprocess
import sys
import time

ROOT = Path('/usr/local/share/openwork-desktop')
STATE = Path('/var/lib/openwork-desktop')
ROUTES = {'/health', '/viewer', '/continue', '/stop', '/browser/task', '/computer/task', '/computer/program', '/browser/demonstration'}
# My files (docs/features/member-files): mirrored here by the runner, where the browser saves downloads.
FILES_ROOT = Path('/files')
WORKSPACE_OUT = Path('/workspace/out')
FILES_USERS = ('openwork-browser', 'openwork-app')
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
       'LANG': 'C.UTF-8', 'DISPLAY': ':99', 'XAUTHORITY': '/run/openwork-desktop/99/.Xauthority'}


def arguments(argv):
    if argv == ['command']:
        return 'command', None
    if len(argv) == 2 and argv[0] == 'start' and re.fullmatch('[a-f0-9]{64}', argv[1]):
        return 'start', argv[1]
    if len(argv) == 2 and argv[0] == 'call' and argv[1] in ROUTES:
        return 'call', argv[1]
    if len(argv) == 2 and argv[0] == 'files' and argv[1] in ('on', 'off'):
        return 'files', argv[1]
    raise ValueError('Use command, start VERSION, files on|off or call with a supported desktop route.')


def call(route, body):
    # Never return the bearer, accept a destination URL, or follow a redirect.
    token = (STATE / 'token').read_text().strip()
    connection = http.client.HTTPConnection('127.0.0.1', 6080, timeout=2 if route == '/health' else 10 if route == '/stop' else 125)
    try:
        connection.request('POST', route, body, {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read(32 * 1024 * 1024)
        if response.status != 200:
            raise RuntimeError('Desktop operation did not finish. Inspect it before retrying.')
        return json.loads(data)
    finally:
        connection.close()


def version():
    digest = hashlib.sha256()
    digest.update((ROOT / 'guest.version').read_bytes())
    # Diagnostics can only be configured by the image operator, never through sudo arguments.
    private = Path('/etc/openwork-desktop/private-browsing').is_file()
    if private:
        digest.update(b'private-browsing')
    return digest.hexdigest(), private


def start(expected):
    actual, private = version()
    if expected != actual:
        raise RuntimeError('The desktop image is out of date. Rebuild its snapshot for this runner.')
    STATE.mkdir(mode=0o711, parents=True, exist_ok=True)
    os.chmod(STATE, 0o711)
    with (STATE / 'start.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if call('/health', '{}').get('version') == actual:
                return {'ok': True, 'version': actual}
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            pass
        pidfile = STATE / 'guest.pid'
        if pidfile.exists():
            pid = int(pidfile.read_text())
            try:
                command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                if command[:2] == [b'/usr/local/bin/node', os.fsencode(ROOT / 'guest.mjs')]:
                    os.kill(pid, signal.SIGTERM)
                    for _ in range(50):
                        if not Path(f'/proc/{pid}').exists():
                            break
                        time.sleep(0.1)
                    else:
                        os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
        subprocess.run(['/bin/sh', str(ROOT / 'start.sh'), str(STATE), ':99'],
                       env={**ENV, 'WORKBOT_DESKTOP_VNC': '1'}, check=True, timeout=30)
        if not (STATE / 'token').exists():
            (STATE / 'token').write_text(secrets.token_urlsafe(32))
        env = {**ENV, 'WORKBOT_DESKTOP_STATE': str(STATE), 'WORKBOT_DESKTOP_VERSION': actual}
        if private:
            env['WORKBOT_DESKTOP_PRIVATE_BROWSING'] = '1'
        with (STATE / 'guest.log').open('ab') as log:
            child = subprocess.Popen(['/usr/local/bin/node', str(ROOT / 'guest.mjs')], env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        pidfile.write_text(str(child.pid))
    return {'ok': True, 'version': actual}


def shared_folder(parent, name, uid, gid):
    """A real folder (never a link) for the provider account and the shared workspace group: setgid, default ACLs."""
    try:
        os.mkdir(name, 0o2770, dir_fd=parent)
    except FileExistsError:
        pass
    # The command account can write in /files: open without following a link it may have put there, then change the
    # held folder rather than its name.
    folder = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        os.fchown(folder, uid, gid)
        os.fchmod(folder, 0o2770)
        subprocess.run(['setfacl', '-m', 'd:u::rwx,d:g::rwx,d:o::---', f'/proc/self/fd/{folder}'], pass_fds=(folder,), check=True)
    except BaseException:
        os.close(folder)
        raise
    return folder


def point(link, target, uid, gid):
    """Points a home folder's link at `target` in one step; a real folder someone made there is kept."""
    if link.exists() and not link.is_symlink():
        return
    temporary = link.with_name(f'.{link.name}.{secrets.token_hex(4)}')
    os.symlink(target, temporary)
    os.lchown(temporary, uid, gid)
    os.replace(temporary, link)


def member_files(mode):
    """`on`: /files for the shared group, and the browser's and apps' Downloads in it. `off`: Downloads as the image had it."""
    owner = pwd.getpwnam('ubuntu')
    shared = grp.getgrnam('openwork-workspace').gr_gid
    if mode == 'on':
        parent = os.open(str(FILES_ROOT.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            root = shared_folder(parent, FILES_ROOT.name, owner.pw_uid, shared)
        finally:
            os.close(parent)
        try:
            os.close(shared_folder(root, 'Downloads', owner.pw_uid, shared))
        finally:
            os.close(root)
    for user in FILES_USERS:
        account = pwd.getpwnam(user)
        home = Path(account.pw_dir)
        point(home / 'Downloads', str(FILES_ROOT / 'Downloads' if mode == 'on' else WORKSPACE_OUT), account.pw_uid, account.pw_gid)
        shortcut = home / 'My files'
        if mode == 'on':
            point(shortcut, str(FILES_ROOT), account.pw_uid, account.pw_gid)
        elif shortcut.is_symlink():
            shortcut.unlink()
    return {'ok': True, 'files': mode}


def main(argv):
    operation, argument = arguments(argv)
    if os.geteuid() != 0:
        raise PermissionError('The desktop helper must run through its installed sudo rule.')
    os.umask(0o077)
    if operation == 'start':
        return start(argument)
    if operation == 'files':
        return member_files(argument)
    limit = 1024 * 1024 if operation == 'command' else 65536
    body = sys.stdin.buffer.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Desktop request is too large.')
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise ValueError('Desktop requests must be JSON objects.')
    if operation == 'command':
        if set(parsed) != {'command'} or not isinstance(parsed['command'], str):
            raise ValueError('Provide only a shell command.')
        # The provider account can operate the bridge; the model's shell cannot.
        # No host or desktop bearer enters the command process environment.
        env = {'PATH': ENV['PATH'] + ':/home/openwork-command/.local/bin', 'HOME': '/home/openwork-command', 'LANG': 'C.UTF-8',
               'WORKBOT_COMMAND': parsed['command']}
        os.execve('/usr/sbin/runuser', ['runuser', '-u', 'openwork-command', '--', '/bin/bash', '-c',
                  'umask 007; cd /workspace; exec bash -c "$WORKBOT_COMMAND"'], env)
    return call(argument, body)


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1:])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
