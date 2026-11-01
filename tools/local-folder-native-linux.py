#!/usr/bin/env python3
"""Bounded X11 chooser automation on this test's OWN Xvfb only; no user DISPLAY.

Qualification-only Python stdlib + ctypes/libX11/libXtst; no user desktop APIs.
No portal fallback: chooser must belong to the recorded Chrome PID or its children.
English GTK chooser: real XTEST Ctrl+L, synthetic absolute path, Return (navigate), Return
(default Open/Select). Chrome's read prompt: Tab from default Cancel, Return.
The JS driver requires a real selected handle and granted permission afterwards;
UI differences fail the native gate, never imply success or an OPFS fallback.
"""
import argparse
import ctypes as C
import ctypes.util
import json
import os
import re
import socket
import stat
import struct
import sys
import time
import zlib
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class WindowAttributes(C.Structure):
    _fields_ = [('x', C.c_int), ('y', C.c_int), ('width', C.c_int), ('height', C.c_int),
                ('border_width', C.c_int), ('depth', C.c_int), ('visual', C.c_void_p),
                ('root', C.c_ulong), ('window_class', C.c_int), ('bit_gravity', C.c_int),
                ('win_gravity', C.c_int), ('backing_store', C.c_int),
                ('backing_planes', C.c_ulong), ('backing_pixel', C.c_ulong),
                ('save_under', C.c_int), ('colormap', C.c_ulong), ('map_installed', C.c_int),
                ('map_state', C.c_int), ('all_event_masks', C.c_long), ('your_event_mask', C.c_long),
                ('do_not_propagate_mask', C.c_long), ('override_redirect', C.c_int), ('screen', C.c_void_p)]


def require_viewable(map_state):
    require(map_state == 2, 'Owned X11 window is not viewable')  # Xlib IsViewable


def command_line(raw):
    # Strip only the terminator; extra NULs represent meaningful empty arguments.
    args = raw.split(b'\0')
    if args[-1] == b'':
        args.pop()
    return args


def proc(pid):
    base = Path('/proc') / str(pid)
    fields = (base / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'ppid': int(fields[1]), 'pgid': int(fields[2]), 'start': fields[19],
            'args': command_line((base / 'cmdline').read_bytes()),
            'exe': os.readlink(base / 'exe'), 'uid': base.stat().st_uid}


def profile_matches(args, profile):
    """Exactly one real switch, in either Chrome spelling; never substring matching."""
    expected, values, i = os.fsencode(profile), [], 1
    while i < len(args) and args[i] != b'--':
        arg = args[i]
        if arg == b'--user-data-dir':
            i += 1
            values.append(args[i] if i < len(args) else None)
        elif arg.startswith(b'--user-data-dir='):
            values.append(arg[len(b'--user-data-dir='):])
        elif arg.startswith(b'--user-data-dir'):
            return False
        i += 1
    return values == [expected]


def browser_arguments(chrome, expected_arguments):
    require(len(expected_arguments) > 0 and all(
        isinstance(arg, str) and arg and not any(c.isspace() or c in '\0\ufeff' for c in arg)
        for arg in expected_arguments), 'Expected Chrome arguments must be nonempty and whitespace/NUL-free')
    if len(chrome['args']) != 1:
        return chrome['args']
    # No shell/process-title parsing: recover only our exact complete launch vector.
    require(chrome['args'][0] == os.fsencode(chrome['exe'] + ' ' + ' '.join(expected_arguments)),
            'Chrome flattened argv mismatch')
    return [os.fsencode(chrome['exe']), *map(os.fsencode, expected_arguments)]


def display_entries(environment):
    # Decode ONLY observed DISPLAY entries; never disclose the rest of environ.
    return [entry.decode('utf-8', errors='replace') for entry in environment.split(b'\0')
            if entry.startswith(b'DISPLAY=')]


def verify_processes(a, owner, lookup=proc, uid=None, environment=None, evidence=None):
    """Fail before loading X11 unless the actual CDP browser is still our process."""
    uid = os.getuid() if uid is None else uid
    linux = owner['linux']
    require(re.fullmatch(r':\d+', a.display) and a.display == linux['display'], 'Display ownership mismatch')
    require(linux['chromeSpawn'] == {'source': 'Chrome spawn env', 'display': a.display,
                                    'xvfbPid': a.xvfb_pid}, 'Chrome launch DISPLAY source mismatch')
    require(a.xvfb_pid == linux['xvfbPid'], 'Xvfb PID ownership mismatch')
    require(a.chrome_pid == linux['chromePid'], 'Chrome PID ownership mismatch')
    xvfb, chrome = lookup(a.xvfb_pid), lookup(a.chrome_pid)
    require(xvfb['start'] == linux['xvfbStart'], 'Xvfb PID identity changed')
    require(chrome['start'] == linux['chromeStart'], 'Chrome PID identity changed')
    require(xvfb['uid'] == chrome['uid'] == linux['chromeUid'] == uid, 'Process UID mismatch')
    require(Path(xvfb['exe']).name == 'Xvfb' and b'-displayfd' in xvfb['args']
            and b'-nolisten' in xvfb['args'] and b'tcp' in xvfb['args'], 'Not our isolated Xvfb')
    require(chrome['exe'] == linux['chromeExe'], 'Chrome executable changed')
    launcher = linux['launcher']
    require(launcher['uid'] == uid and launcher['pgid'] == launcher['pid']
            and chrome['pgid'] == linux['chromePgid'] == launcher['pgid']
            and int(chrome['start']) >= int(launcher['start']), 'Chrome launch group mismatch')
    if chrome['pid'] == launcher['pid']:
        require(chrome['start'] == launcher['start'], 'Launcher PID identity changed')
    require(profile_matches(browser_arguments(chrome, linux['expectedArguments']), a.profile), 'Chrome profile mismatch')
    if environment is None:
        environment = (Path('/proc') / str(a.chrome_pid) / 'environ').read_bytes()
    entries = display_entries(environment)
    if evidence is not None:
        evidence['observedDisplayEntries'] = entries
    require(all(entry in ('DISPLAY=', 'DISPLAY=' + a.display) for entry in entries),
            'Observed Chrome DISPLAY contradicts owned Xvfb: ' + json.dumps(entries))
    # An absent/empty DISPLAY is NOT proof. Only ScopedX11's positive server and
    # exact CDP-browser top-level window checks can qualify the target display.
    return xvfb, chrome


class ScopedX11:
    """All focus/key actions require fresh process, connected-server and window proof.

    Callbacks let the embedded self-test exercise the real action boundary without
    loading libX11 or touching any display. Runtime peer is Linux SO_PEERCRED on
    XConnectionNumber, not an assertion about a requested display string.
    """
    def __init__(self, a, processes, peer, windows, window_pids, lookup, owned, evidence):
        self.a, self.processes, self.peer = a, processes, peer
        self.windows, self.window_pids, self.lookup, self.owned = windows, window_pids, lookup, owned
        self.evidence, self.targets = evidence, {}

    def server(self):
        self.evidence['displayProof'] = {'status': 'awaiting-x11-proof', 'displayQualified': False}
        xvfb, chrome = self.processes()
        peer_pid, peer_uid = self.peer()
        self.evidence['connectedServer'] = {'pid': peer_pid, 'uid': peer_uid}
        require((peer_pid, peer_uid) == (xvfb['pid'], xvfb['uid']), 'Connected X11 server is not owned Xvfb')
        self.evidence['displayProof']['status'] = 'server-bound-awaiting-browser-window'
        return xvfb, chrome

    def verify(self, w, pid):
        xvfb, chrome = self.server()
        top = self.windows()
        browser_windows = [window for window in top if self.window_pids(window) == [chrome['pid']]]
        require(browser_windows, 'No exact CDP Chrome top-level window on owned Xvfb')
        require(w in top and self.window_pids(w) == [pid] and self.owned(pid),
                'Target is not an owned top-level window on owned Xvfb')
        target = self.lookup(pid)
        identity = {key: target[key] for key in ('pid', 'start', 'exe', 'uid', 'pgid')}
        require(target['exe'] == chrome['exe'] and target['uid'] == chrome['uid'], 'Target executable/UID changed')
        require(identity == self.targets.setdefault((w, pid), identity), 'Target process identity changed')
        self.evidence['displayProof'] = {'status': 'x11-owned-window-proved', 'displayQualified': True,
                                         'display': self.a.display, 'serverPid': xvfb['pid'], 'serverUid': xvfb['uid'],
                                         'browserPid': chrome['pid'], 'browserWindows': browser_windows,
                                         'window': w, 'windowProcess': identity}

    def act(self, w, pid, action):
        self.verify(w, pid)
        return action()


def scoped_key(scope, w, pid, codes, emit, grab, ungrab, sync, focus, release_focus):
    """One chord on a positively owned server, never a system-wide keyboard API.

    Grab only that server and hold it across target/focus proof and the paired
    releases. Other clients cannot steal focus mid-chord. Cleanup releases only
    keys pressed by this chord, with fresh full target/focus proof; loss of that
    proof forbids even a release. The driver then tears down its private Xvfb.
    """
    scope.verify(w, pid)
    grab()
    try:
        scope.verify(w, pid)
        focus()
        pressed = []
        try:
            for code in codes:
                pressed.append(code)  # also clean up an emit that raises after queueing
                require(emit(code, True), 'Owned XTEST key press failed')
        finally:
            if pressed:
                scope.verify(w, pid)  # no unchecked release on server/window/identity loss
                release_focus()
                errors = []
                for code in reversed(pressed):
                    try:
                        require(emit(code, False), 'Owned XTEST key release failed')
                    except Exception as error:
                        errors.append(error)
                if errors:
                    raise errors[0]
    finally:
        try:
            sync()
        finally:
            ungrab()


def verified_focus(top, focused, parent, pids, viewable, pid):
    """GTK may focus a descendant with no PID property, not an unrelated window."""
    require_viewable(viewable(top))
    seen = set()
    while focused != top:
        require(focused not in (0, 1) and focused not in seen and len(seen) < 32,
                'Focus is outside the exact owned target')
        seen.add(focused)
        require_viewable(viewable(focused))
        require(pids(focused) in (None, [pid]), 'Focused descendant PID mismatch')
        focused = parent(focused)
    return True


def require_chooser_closed(windows):
    # Absence of a viewable chooser is not proof of closure: an extant unmapped
    # chooser may be transitioning. Fail closed rather than send Allow behind it.
    require(not any(window['dialog'] for window in windows),
            'Owned native chooser still present; refusing browser Allow input')


def candidate_windows(windows, mode, chrome_pid):
    viewable = [window for window in windows if window['mapState'] == 'IsViewable']
    if mode in ('select', 'cancel'):
        return [window for window in viewable if window['dialog']]
    return [window for window in viewable if not window['dialog'] and window['pid'] == chrome_pid
            and 'Code City synthetic native qualification' in window['title']]


def key_symbol(name, lookup):
    # XStringToKeysym needs names such as slash/minus/period for punctuation;
    # ASCII's numeric keysyms are simply its Latin-1 code points.
    return ord(name) if len(name) == 1 else lookup(name.encode())


def typing_modifiers(char):
    return 1 if char.isupper() or char == '_' else 0


if sys.argv[1:] == ['--self-test']:
    for char in '/tmp/CodeCitySynthetic-a_b.123':
        require(key_symbol(char, lambda _: 0) == ord(char), 'ASCII keysym regression')
    require(key_symbol('Return', lambda name: 0xff0d if name == b'Return' else 0) == 0xff0d,
            'Named keysym regression')
    require([typing_modifiers(c) for c in 'C_/-az'] == [1, 1, 0, 0, 0, 0], 'Shift-mask regression')
    require_viewable(2)
    for state in [0, 1, -1, 3]:
        try:
            require_viewable(state)
        except RuntimeError:
            continue
        raise RuntimeError('Unmapped/unviewable target accepted')
    profile = '/tmp/owned'
    for args in [[b'chrome', b'--user-data-dir=/tmp/owned'],
                 [b'chrome', b'--user-data-dir', b'/tmp/owned']]:
        require(profile_matches(args, profile), 'Recognized profile switch rejected')
    for args in [[], [b'chrome'], [b'chrome', b'--user-data-dir'],
                 [b'chrome', b'--user-data-dir='], [b'chrome', b'--user-data-dir', b''],
                 [b'chrome', b'--user-data-dir=/tmp/owned-extra'],
                 [b'chrome', b'--user-data-dir=/wrong'],
                 [b'chrome', b'--user-data-directory=/tmp/owned'],
                 [b'chrome', b'--other=--user-data-dir=/tmp/owned'],
                 [b'chrome', b'--', b'--user-data-dir=/tmp/owned'],
                 [b'chrome', b'--user-data-dir=/tmp/owned', b'--user-data-dir=/tmp/owned'],
                 [b'chrome', b'--user-data-dir', b'/tmp/owned', b'--user-data-dir=/wrong'],
                 [b'chrome', b'--user-data-dir=/wrong', b'--user-data-dir', b'/tmp/owned']]:
        require(not profile_matches(args, profile), 'Ambiguous/wrong profile accepted: ' + repr(args))
    require(profile_matches([b'chrome', b'--user-data-dir=/tmp/owned-\xff'], b'/tmp/owned-\xff'),
            'Profile comparison must preserve filesystem bytes')
    a = argparse.Namespace(xvfb_pid=90, chrome_pid=101, profile=profile, display=':7')
    xvfb = {'pid': 90, 'start': '100', 'uid': 42, 'exe': '/usr/bin/Xvfb',
            'args': [b'Xvfb', b'-displayfd', b'3', b'-nolisten', b'tcp']}
    chrome = {'pid': 101, 'pgid': 100, 'start': '201', 'uid': 42, 'exe': '/opt/google/chrome/chrome',
              'args': [b'chrome', b'--user-data-dir=/tmp/owned']}
    launcher = {'pid': 100, 'pgid': 100, 'start': '200', 'uid': 42}
    linux = {'xvfbPid': 90, 'xvfbStart': '100', 'chromePid': 101, 'chromeStart': '201',
             'chromeExe': chrome['exe'], 'chromeUid': 42, 'chromePgid': 100, 'launcher': launcher,
             'expectedArguments': ['--user-data-dir=/tmp/owned'], 'display': ':7',
             'chromeSpawn': {'source': 'Chrome spawn env', 'display': ':7', 'xvfbPid': 90}}

    def check(c=chrome, x=xvfb, l=linux, env=b'DISPLAY=:7\0'):
        return verify_processes(a, {'linux': l}, lambda pid: x if pid == 90 else c, 42, env)

    def refuses(f):
        try:
            f()
        except RuntimeError:
            return
        raise RuntimeError('Ownership guard accepted invalid identity')

    check()
    check(c={**chrome, 'args': [b'chrome', b'--user-data-dir', b'/tmp/owned']})
    check(l={**linux, 'launcher': {**launcher, 'pid': 101, 'pgid': 101, 'start': '201'}, 'chromePgid': 101},
          c={**chrome, 'pgid': 101})
    for change in [{'uid': 43}, {'start': '202'}, {'exe': '/other'}, {'pgid': 99},
                   {'args': [b'chrome', b'--user-data-dir=/wrong']}]:
        refuses(lambda change=change: check(c={**chrome, **change}))
    for change in [{'uid': 43}, {'start': '101'}, {'exe': '/other'}, {'args': [b'Xvfb']}]:
        refuses(lambda change=change: check(x={**xvfb, **change}))
    for change in [{'chromePid': 102}, {'xvfbPid': 91}, {'chromeUid': 43}, {'chromePgid': 99},
                   {'launcher': {**launcher, 'start': '202'}},
                   {'launcher': {**launcher, 'pgid': 99}}, {'launcher': {**launcher, 'uid': 43}}]:
        refuses(lambda change=change: check(l={**linux, **change}))
    refuses(lambda: check(env=b'DISPLAY=:70\0'))
    for env in [b'', b'OTHER=not-recorded\0', b'DISPLAY=\0', b'DISPLAY=:7\0DISPLAY=\0']:
        check(env=env)
    for env in [b'DISPLAY=:7-extra\0', b'DISPLAY=:7\0DISPLAY=:8\0', b'DISPLAY=localhost:7\0']:
        refuses(lambda env=env: check(env=env))
    require(display_entries(b'SECRET=not-recorded\0DISPLAY=:70\0DISPLAY=\0') == ['DISPLAY=:70', 'DISPLAY='],
            'Evidence must contain only observed DISPLAY entries')
    for change in [{'display': ':70'}, {'chromeSpawn': {'source': '/proc/environ', 'display': ':7', 'xvfbPid': 90}},
                   {'chromeSpawn': {'source': 'Chrome spawn env', 'display': ':70', 'xvfbPid': 90}},
                   {'chromeSpawn': {'source': 'Chrome spawn env', 'display': ':7', 'xvfbPid': 91}}]:
        refuses(lambda change=change: check(l={**linux, **change}))
    # Exercise the actual focus/key action gate. Empty proc metadata alone must
    # never permit actions; server and exact CDP top-level window are mandatory.
    state = {}
    evidence, sent = {}, []

    def reset():
        state.update(peer=(90, 42), top=[501, 502], pids={501: [101], 502: [102]}, chrome=chrome,
                     xvfb=xvfb, target={**chrome, 'pid': 102, 'start': '202'}, env=b'', owned=True)
        evidence.clear()
        sent.clear()
        return ScopedX11(a, lambda: check(c=state['chrome'], x=state['xvfb'], env=state['env']),
                         lambda: state['peer'], lambda: state['top'], lambda w: state['pids'].get(w),
                         lambda pid: state['chrome'] if pid == 101 else state['target'],
                         lambda pid: state['owned'] and pid in (101, 102), evidence)

    for env in [b'', b'DISPLAY=\0', b'DISPLAY=:7\0']:
        guard = reset()
        state['env'] = env
        require('displayProof' not in evidence, 'Process binding must not qualify display')
        guard.act(502, 102, lambda: sent.append('focus'))
        guard.act(502, 102, lambda: sent.append('key'))
        require(sent == ['focus', 'key'] and evidence['displayProof']['displayQualified'], 'Positive X11 proof rejected')
    guard = reset()
    state['top'] = [501]
    guard.act(501, 101, lambda: sent.append('browser-focus'))
    require(sent == ['browser-focus'], 'Exact CDP browser target rejected')
    for change in [{'peer': (91, 42)}, {'peer': (90, 43)}, {'top': []}, {'top': [502]}, {'owned': False},
                   {'pids': {501: [1010], 502: [102]}}, {'pids': {501: [101, 999], 502: [102]}},
                   {'pids': {501: [101], 502: [999]}}, {'pids': {501: [101], 502: [102, 999]}},
                   {'target': {**chrome, 'pid': 102, 'exe': '/wrong', 'start': '202'}},
                   {'chrome': {**chrome, 'start': '999'}}, {'xvfb': {**xvfb, 'start': '999'}},
                   {'env': b'DISPLAY=:70\0'}, {'env': b'DISPLAY=:7\0DISPLAY=:8\0'}]:
        guard = reset()
        state.update(change)
        refuses(lambda: guard.act(502, 102, lambda: sent.append('forbidden')))
        require(not sent and not evidence['displayProof']['displayQualified'], 'UI action without own X11 proof')
    for change in [{'start': '999'}, {'exe': '/wrong'}, {'uid': 43}, {'pgid': 999}]:
        guard = reset()
        guard.act(502, 102, lambda: sent.append('focus'))
        state['target'] = {**state['target'], **change}
        refuses(lambda: guard.act(502, 102, lambda: sent.append('forbidden-key')))
        require(sent == ['focus'] and not evidence['displayProof']['displayQualified'], 'Target identity not rechecked before key')
    for change in [{'peer': (91, 42)}, {'pids': {501: [101], 502: [999]}}, {'top': [502]},
                   {'chrome': {**chrome, 'exe': '/wrong'}}, {'xvfb': {**xvfb, 'uid': 43}}]:
        guard = reset()
        guard.act(502, 102, lambda: sent.append('focus'))
        state.update(change)
        refuses(lambda: guard.act(502, 102, lambda: sent.append('forbidden-key')))
        require(sent == ['focus'], 'Server/browser/window not rechecked before key')
    # Exercise real chord orchestration, including modifier and failure cleanup.
    def chord(guard, emit=None, focus=lambda: None):
        scoped_key(guard, 502, 102, [37, 46], emit or (lambda code, down: sent.append((code, down)) or 1),
                   lambda: sent.append('grab'), lambda: sent.append('ungrab'),
                   lambda: sent.append('sync'), focus, focus)

    guard = reset()
    chord(guard)
    require(sent == ['grab', (37, True), (46, True), (46, False), (37, False), 'sync', 'ungrab'],
            'XTEST chord must pair and reverse-release actual modifier keys')
    for failing in [(37, True), (46, True), (46, False)]:
        guard = reset()
        def fail_emit(code, down):
            sent.append((code, down))
            if (code, down) == failing:
                raise RuntimeError('injected XTEST failure')
            return 1
        refuses(lambda: chord(guard, fail_emit))
        require((37, False) in sent and sent[-2:] == ['sync', 'ungrab'], 'Modifier cleanup/grab leaked')
        if failing != (37, True):
            require((46, False) in sent, 'Main key cleanup missing')
    for change in [{'peer': (91, 42)}, {'pids': {501: [101], 502: [999]}}, {'top': [502]}]:
        guard = reset()
        state.update(change)
        refuses(lambda: chord(guard))
        require(not sent, 'Unproved server/window received part of a chord')
    guard = reset()
    refuses(lambda: chord(guard, focus=lambda: require(False, 'wrong focus')))
    require(sent == ['grab', 'sync', 'ungrab'], 'Focus refusal emitted keys or leaked grab')
    guard = reset()
    def changed_at_grab():
        sent.append('grab')
        state['peer'] = (91, 42)
    refuses(lambda: scoped_key(guard, 502, 102, [37, 46], lambda *_: sent.append('forbidden'),
                               changed_at_grab, lambda: sent.append('ungrab'), lambda: sent.append('sync'), lambda: None, lambda: None))
    require(sent == ['grab', 'sync', 'ungrab'], 'Proof not refreshed after grabbing owned server')
    guard = reset()
    def lost_server(code, down):
        sent.append((code, down))
        state['peer'] = (91, 42)
        raise RuntimeError('server proof lost')
    refuses(lambda: chord(guard, lost_server))
    require(sent == ['grab', (37, True), 'sync', 'ungrab'], 'Lost server received unchecked release')
    for change in [{'top': [501]}, {'pids': {501: [101], 502: [999]}},
                   {'target': {**chrome, 'pid': 102, 'start': '999'}}]:
        guard = reset()
        def lost_target(code, down):
            sent.append((code, down))
            state.update(change)
            raise RuntimeError('target proof lost')
        refuses(lambda: chord(guard, lost_target))
        require(sent == ['grab', (37, True), 'sync', 'ungrab'], 'Lost target received unchecked release')
    guard = reset()
    def focus_lost_after_press():
        require(not any(isinstance(event, tuple) and event[1] for event in sent), 'injected focus loss')
    refuses(lambda: chord(guard, focus=focus_lost_after_press))
    require(sent == ['grab', (37, True), (46, True), 'sync', 'ungrab'], 'Lost focus received unchecked release')
    for focused in [502, 503, 504]:
        require(verified_focus(502, focused, lambda w: {503: 502, 504: 503}[w],
                               lambda w: [102] if w == 503 else None, lambda w: 2, 102),
                'Owned GTK descendant focus rejected')
    for focused, parents, pids, maps in [
            (0, {}, {}, {}), (1, {}, {}, {}), (501, {501: 0}, {}, {}),
            (503, {503: 503}, {}, {}), (503, {503: 502}, {503: [999]}, {}),
            (503, {503: 502}, {}, {503: 1}), (502, {}, {}, {502: 0})]:
        refuses(lambda: verified_focus(502, focused, lambda w: parents[w],
                                       lambda w: pids.get(w), lambda w: maps.get(w, 2), 102))
    require_chooser_closed([{'dialog': False}])
    refuses(lambda: require_chooser_closed([{'dialog': False}, {'dialog': True}]))
    for map_state in ['IsUnmapped', 'IsUnviewable', 'IsViewable']:
        dialog = {'window': 502, 'pid': 102, 'dialog': True, 'mapState': map_state, 'title': 'Select Folder'}
        browser = {'window': 501, 'pid': 101, 'dialog': False, 'mapState': 'IsViewable',
                   'title': 'Code City synthetic native qualification'}
        require(candidate_windows([browser, dialog], 'select', 101) == ([dialog] if map_state == 'IsViewable' else []),
                'Premapped chooser selected for focus/input')
        require(candidate_windows([browser, dialog], 'inspect', 101) == [browser], 'Browser inspection target regression')
        refuses(lambda: require_chooser_closed([browser, dialog]))
    # Complete rewritten argv[0] from CI 41263489673; byte parser remains strict.
    a.profile = '/tmp/code-city-native-o8tUex/profile'
    expected_arguments = ['--remote-debugging-port=0', '--user-data-dir=' + a.profile,
                          '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
                          '--disable-component-update', '--disable-default-apps', '--disable-sync',
                          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
                          '--disable-features=CalculateNativeWinOcclusion', '--lang=en-US',
                          '--ozone-platform=x11', '--disable-gpu', '--window-size=900,650', 'about:blank']
    title = chrome['exe'] + ' ' + ' '.join(expected_arguments)
    flat = {**chrome, 'args': command_line(os.fsencode(title) + b'\0')}
    flat_linux = {**linux, 'expectedArguments': expected_arguments}

    def check_flat(c=flat, l=flat_linux, env=b'DISPLAY=:7\0'):
        return check(c=c, l=l, env=env)

    check_flat()
    # Model same-PID exec using the CDP PID already checked by verify_processes.
    direct_linux = {**flat_linux, 'launcher': {**launcher, 'pid': 101, 'pgid': 101, 'start': '201'},
                    'chromePgid': 101}
    check_flat(c={**flat, 'pgid': 101}, l=direct_linux)
    check_flat(c={**flat, 'args': [b'chrome', *map(os.fsencode, expected_arguments)]})
    require(browser_arguments(flat, expected_arguments) == [os.fsencode(chrome['exe']), *map(os.fsencode, expected_arguments)],
            'Exact title did not recover the launch vector')
    require(flat['args'] == [os.fsencode(title)], 'Raw failure evidence must not be rewritten')
    for raw, parsed in [(b'', []), (b'\0', [b'']), (b'chrome\0\0', [b'chrome', b'']),
                        (b'\0chrome\0\0arg\0', [b'', b'chrome', b'', b'arg']),
                        (b'chrome\0arg', [b'chrome', b'arg'])]:
        require(command_line(raw) == parsed, 'Meaningful argv entries lost')
    switch = '--user-data-dir=' + a.profile
    for changed_title in [title.replace('--no-first-run', '--no-first-rum'),
                          title.replace(a.profile, a.profile + '-wrong'), title.replace(switch + ' ', ''),
                          title.replace(switch, switch + ' ' + switch), title + ' --extra', title + ' ',
                          title.replace(' --no-first-run', '\t--no-first-run'),
                          title.replace(' --no-first-run', '\0--no-first-run'),
                          title.replace(chrome['exe'], chrome['exe'] + '-spoof'),
                          title.replace(chrome['exe'], '/wrong/chrome'),
                          title.replace(' --no-first-run', '  --no-first-run')]:
        refuses(lambda changed_title=changed_title: check_flat(c={**flat, 'args': command_line(os.fsencode(changed_title) + b'\0')}))
    refuses(lambda: check_flat(c={**flat, 'args': [os.fsencode(title), b'']}))
    refuses(lambda: check_flat(c={**flat, 'exe': chrome['exe'] + '-changed'}))
    for arg in ['', 'a b', 'a\tb', 'a\nb', 'a\rb', 'a\u00a0b', 'a\u0085b', 'a\ufeffb', 'a\u001cb', 'a\u001fb', 'a\0b']:
        expected = [*expected_arguments, arg]
        refuses(lambda expected=expected: check_flat(
            c={**flat, 'args': [os.fsencode(chrome['exe'] + ' ' + ' '.join(expected))]},
            l={**flat_linux, 'expectedArguments': expected}))
    for expected in [[arg for arg in expected_arguments if not arg.startswith('--user-data-dir=')],
                     [*expected_arguments, switch],
                     ['--user-data-dir=/wrong' if arg == switch else arg for arg in expected_arguments]]:
        refuses(lambda expected=expected: check_flat(
            c={**flat, 'args': [os.fsencode(chrome['exe'] + ' ' + ' '.join(expected))]},
            l={**flat_linux, 'expectedArguments': expected}))
    for change in [{'uid': 43}, {'pgid': 90}, {'start': '199'}, {'start': '202'}]:
        refuses(lambda change=change: check_flat(c={**flat, **change}))
    refuses(lambda: check_flat(c={**flat, 'pgid': 101, 'start': '202'},
                              l={**direct_linux, 'chromeStart': '202'}))
    for change in [{'uid': 43}, {'pgid': 90}, {'start': '202'}]:
        refuses(lambda change=change: check_flat(l={**flat_linux, 'launcher': {**launcher, **change}}))
    refuses(lambda: check_flat(env=b'DISPLAY=:70\0'))
    print(json.dumps({'status': 'passed', 'scope': 'synthetic process ownership, exact profile bytes, full flattened argv/spoof refusals, DISPLAY contradiction/source guards and DISPLAY-only evidence; empty metadata defers to exact connected-Xvfb/CDP top-level window proof; focus/key action boundary and identity rechecks; raw/empty argv preservation, ASCII/named keysyms and Shift masks; viewable map states, XTEST modifier/key cleanup, lost-proof release refusal, exact/descendant focus refusals and chooser-before-Allow guard; no X11/native runtime'}))
    sys.exit(0)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--display', required=True)
parser.add_argument('--xvfb-pid', type=int, required=True)
parser.add_argument('--chrome-pid', type=int, required=True)
parser.add_argument('--profile', required=True)
parser.add_argument('--ownership', required=True)
parser.add_argument('--mode', choices=['select', 'allow-read', 'cancel', 'inspect'], required=True)
parser.add_argument('--fixture', required=True)
parser.add_argument('--diagnostic-png', required=True)
a = parser.parse_args()
require(re.fullmatch(r':\d+', a.display), 'Only a local isolated display number is allowed')
evidence = {'display': a.display, 'mode': a.mode, 'actions': [], 'phase': 'process-check',
            'displayProof': {'status': 'process-check-pending', 'displayQualified': False}}


def failure_json(kind, error, traceback):
    evidence.update(status='failed', error=str(error))
    evidence['displayProof'] = {**evidence['displayProof'], 'status': 'failed', 'displayQualified': False}
    print(json.dumps(evidence))
    sys.__excepthook__(kind, error, traceback)


sys.excepthook = failure_json
evidence['helperDisplayEntries'] = ['DISPLAY=' + os.environ['DISPLAY']] if 'DISPLAY' in os.environ else []
require(os.environ.get('DISPLAY') == a.display, 'Helper spawn DISPLAY must be exactly owned Xvfb')
owner = json.loads(Path(a.ownership).read_text())
require(a.fixture in (owner['fixture'], owner['empty']), 'Not an owned fixture')
require(a.profile == owner['profile'], 'Profile ownership mismatch')
require(a.display == owner['linux']['display'], 'Display ownership mismatch')
xvfb, chrome = verify_processes(a, owner, evidence=evidence)
evidence['displayProof'] = {'status': 'process-bound-awaiting-x11-proof', 'displayQualified': False}
s = os.lstat(a.fixture)
expected = owner['identities'][a.fixture]
require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
        and s.st_dev == expected['dev'] and s.st_ino == expected['ino'], 'Fixture identity changed')
require(re.fullmatch(r'CodeCitySynthetic-[a-f0-9-]+(?:-empty)?', Path(a.fixture).name),
        'Not a synthetic fixture name')
require(re.fullmatch(r'[A-Za-z0-9_./-]+', a.fixture), 'Fixture path not supported by scoped ASCII typing')

lib = ctypes.util.find_library('X11')
require(lib, 'libX11 is required for real native folder qualification')
x = C.CDLL(lib)
Window = C.c_ulong
Display = C.c_void_p


def bind(name, restype, args):
    f = getattr(x, name)
    f.restype, f.argtypes = restype, args
    return f


open_display = bind('XOpenDisplay', Display, [C.c_char_p])
close_display = bind('XCloseDisplay', C.c_int, [Display])
connection_number = bind('XConnectionNumber', C.c_int, [Display])
root_window = bind('XDefaultRootWindow', Window, [Display])
get_attributes = bind('XGetWindowAttributes', C.c_int, [Display, Window, C.POINTER(WindowAttributes)])
query_tree = bind('XQueryTree', C.c_int, [Display, Window, C.POINTER(Window), C.POINTER(Window), C.POINTER(C.POINTER(Window)), C.POINTER(C.c_uint)])
atom = bind('XInternAtom', C.c_ulong, [Display, C.c_char_p, C.c_int])
get_property = bind('XGetWindowProperty', C.c_int, [Display, Window, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ubyte))])
free = bind('XFree', C.c_int, [C.c_void_p])
x_sync = bind('XSync', C.c_int, [Display, C.c_int])


class XError(C.Structure):
    _fields_ = [('type', C.c_int), ('display', Display), ('resource', C.c_ulong), ('serial', C.c_ulong),
                ('code', C.c_ubyte), ('request', C.c_ubyte), ('minor', C.c_ubyte)]


x_errors = []
XErrorHandler = C.CFUNCTYPE(C.c_int, Display, C.POINTER(XError))


@XErrorHandler
def record_x_error(_display, event):
    if len(x_errors) < 8:
        x_errors.append({'code': event.contents.code, 'request': event.contents.request,
                         'resource': event.contents.resource})
    return 0


bind('XSetErrorHandler', C.c_void_p, [XErrorHandler])(record_x_error)


def flush(display, discard):
    x_sync(display, discard)
    if x_errors:
        evidence['xErrors'] = list(x_errors)
        x_errors.clear()
        raise RuntimeError('Owned X11 request failed: ' + json.dumps(evidence['xErrors']))
set_focus = bind('XSetInputFocus', C.c_int, [Display, Window, C.c_int, C.c_ulong])
get_focus = bind('XGetInputFocus', C.c_int, [Display, C.POINTER(Window), C.POINTER(C.c_int)])
keysym = bind('XStringToKeysym', C.c_ulong, [C.c_char_p])
keycode = bind('XKeysymToKeycode', C.c_ubyte, [Display, C.c_ulong])


grab_server = bind('XGrabServer', C.c_int, [Display])
ungrab_server = bind('XUngrabServer', C.c_int, [Display])
query_keymap = bind('XQueryKeymap', C.c_int, [Display, C.c_void_p])
xtst_lib = ctypes.util.find_library('Xtst')
require(xtst_lib, 'libXtst is required only for real native Linux qualification')
xtst = C.CDLL(xtst_lib)
query_xtest = xtst.XTestQueryExtension
query_xtest.restype, query_xtest.argtypes = C.c_int, [Display] + [C.POINTER(C.c_int)] * 4
fake_key = xtst.XTestFakeKeyEvent
fake_key.restype, fake_key.argtypes = C.c_int, [Display, C.c_uint, C.c_int, C.c_ulong]
d = open_display(a.display.encode())
require(d, 'Owned Xvfb display unavailable (never falling back to user DISPLAY)')
root = root_window(d)
actions = evidence['actions']


def property_value(w, name):
    actual, fmt, count, after = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong()
    data = C.POINTER(C.c_ubyte)()
    status = get_property(d, w, atom(d, name.encode(), 0), 0, 1024, 0, 0,
                          C.byref(actual), C.byref(fmt), C.byref(count), C.byref(after), C.byref(data))
    require(status == 0, 'X11 property read failed')
    try:
        if not data or not count.value:
            return None
        if fmt.value == 32:
            return [C.cast(data, C.POINTER(C.c_ulong))[i] for i in range(count.value)]
        return C.string_at(data, count.value).decode('utf-8', errors='replace')
    finally:
        if data:
            free(data)


def window_tree(w):
    r, parent, count, data = Window(), Window(), C.c_uint(), C.POINTER(Window)()
    require(query_tree(d, w, C.byref(r), C.byref(parent), C.byref(data), C.byref(count)), 'X11 tree read failed')
    try:
        return parent.value, list(data[:count.value])
    finally:
        if data:
            free(data)


def children(w):
    return window_tree(w)[1]


def owned(pid):
    try:
        p = proc(pid)
        if p['uid'] != chrome['uid'] or p['exe'] != chrome['exe']:
            return False
        for _ in range(10):
            if p['pid'] == a.chrome_pid:
                return p['start'] == chrome['start']
            if p['ppid'] <= 1:
                return False
            p = proc(p['ppid'])
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
    return False


def window_map_state(w):
    attributes = WindowAttributes()
    require(get_attributes(d, w, C.byref(attributes)), 'Owned X11 window attributes unavailable')
    return attributes.map_state


def owned_windows():
    scope.server()
    found = []
    for w in children(root):
        pids = property_value(w, '_NET_WM_PID')
        if not pids or len(pids) != 1 or not owned(pids[0]):
            continue
        # Include premapped/hidden windows in diagnostics/closure checks, but
        # candidate_windows never allows them to receive focus or input.
        map_state = window_map_state(w)
        scope.verify(w, pids[0])
        role = property_value(w, 'WM_WINDOW_ROLE') or ''
        title = property_value(w, '_NET_WM_NAME') or property_value(w, 'WM_NAME') or ''
        transient = property_value(w, 'WM_TRANSIENT_FOR')
        types = property_value(w, '_NET_WM_WINDOW_TYPE') or []
        dialog = (atom(d, b'_NET_WM_WINDOW_TYPE_DIALOG', 0) in types
                  or 'file' in role.lower() or bool(transient))
        found.append({'window': w, 'pid': pids[0], 'role': role, 'title': title,
                      'dialog': dialog, 'mapState': {0: 'IsUnmapped', 1: 'IsUnviewable', 2: 'IsViewable'}.get(map_state, 'unknown')})
    evidence['windows'] = found
    evidence['chooserClosed'] = not any(window['dialog'] for window in found)
    return found


def connected_server():
    # Duplicate only the already-open X11 connection; never open another display.
    with socket.fromfd(connection_number(d), socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                                                struct.calcsize('3i')))
        return pid, uid


scope = ScopedX11(a, lambda: verify_processes(a, owner, evidence=evidence), connected_server,
                  lambda: children(root), lambda w: property_value(w, '_NET_WM_PID'), proc, owned, evidence)


def require_focus(w, pid):
    focused, revert = Window(), C.c_int()
    get_focus(d, C.byref(focused), C.byref(revert))
    verified_focus(w, focused.value, lambda child: window_tree(child)[0],
                   lambda child: property_value(child, '_NET_WM_PID'), window_map_state, pid)
    evidence['focus'] = {'target': w, 'actual': focused.value, 'verifiedDescendant': focused.value != w}


def focus_target(w, pid):
    scope.verify(w, pid)
    grab_server(d)
    try:
        scope.verify(w, pid)
        require_viewable(window_map_state(w))
        set_focus(d, w, 1, 0)
        flush(d, 0)
        require_focus(w, pid)
    finally:
        ungrab_server(d)
        flush(d, 0)


def key(w, pid, name, modifiers=0):
    require(modifiers in (0, 1, 4), 'Unsupported XTEST modifiers')
    names = (['Shift_L'] if modifiers == 1 else ['Control_L'] if modifiers == 4 else []) + [name]
    codes = [keycode(d, key_symbol(n, keysym)) for n in names]
    require(all(codes) and len(set(codes)) == len(codes), 'Key unavailable/ambiguous on isolated X11 keyboard: ' + name)
    def focus():
        require_focus(w, pid)
        if a.mode == 'allow-read':
            require_chooser_closed(owned_windows())  # recheck under grab before EVERY chord
        keymap = (C.c_ubyte * 32)()
        query_keymap(d, keymap)
        require(not any(keymap), 'Owned Xvfb already has depressed keys; refusing input')
    scoped_key(scope, w, pid, codes, lambda code, down: fake_key(d, code, int(down), 0),
               lambda: grab_server(d), lambda: (ungrab_server(d), flush(d, 0)), lambda: flush(d, 0),
               focus, lambda: require_focus(w, pid))
    evidence['input']['chordsCompleted'] += 1
    evidence['input']['lastKey'] = name


# Minimal diagnostic image: only this already-proved private Xvfb root. No desktop,
# filesystem/source inspection or profile contents. Downsample to bound work/size.
def diagnostic_png():
    windows = owned_windows()
    browser = next(window for window in candidate_windows(windows, 'inspect', a.chrome_pid))
    scope.verify(browser['window'], a.chrome_pid)
    # libX11 Macros.c exports these callable equivalents for non-C clients.
    # Bind inside the optional diagnostic so an unusual library cannot turn an
    # unavailable image into an input/qualification-path initialization failure.
    get_image = bind('XGetImage', C.c_void_p, [Display, Window, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_ulong, C.c_int])
    get_pixel = bind('XGetPixel', C.c_ulong, [C.c_void_p, C.c_int, C.c_int])
    destroy_image = bind('XDestroyImage', C.c_int, [C.c_void_p])
    attributes = WindowAttributes()
    require(get_attributes(d, root, C.byref(attributes)), 'Owned root attributes unavailable')
    width, height = attributes.width, attributes.height
    require(0 < width <= 1920 and 0 < height <= 1200 and attributes.depth == 24,
            'Diagnostic requires bounded 24-bit owned Xvfb root')
    image = get_image(d, root, 0, 0, width, height, C.c_ulong(-1).value, 2)
    require(image, 'Owned root image unavailable')
    try:
        step = max(1, (max(width, height) + 639) // 640)
        rows = bytearray()
        for y in range(0, height, step):
            rows.append(0)
            for x_pos in range(0, width, step):
                pixel = get_pixel(image, x_pos, y)
                rows.extend(((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255))
        def chunk(kind, data):
            return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', (width + step - 1) // step,
              (height + step - 1) // step, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
        with open(a.diagnostic_png, 'xb') as output:
            output.write(png)
        evidence['diagnosticPng'] = a.diagnostic_png
    finally:
        destroy_image(image)


def diagnose():
    try:
        diagnostic_png()
    except Exception as error:
        evidence['diagnosticError'] = str(error)


try:
    scope.server()  # No XTEST query/input or screenshot before connected-server proof.
    extension = [C.c_int() for _ in range(4)]
    require(query_xtest(d, *(C.byref(value) for value in extension)), 'Owned Xvfb lacks XTEST extension')
    evidence['input'] = {'transport': 'XTEST', 'version': [extension[2].value, extension[3].value], 'chordsCompleted': 0}
    evidence['phase'] = 'find-owned-viewable-window'
    end = time.monotonic() + 8
    while True:
        windows = owned_windows()
        if a.mode == 'allow-read':
            require_chooser_closed(windows)
        found = candidate_windows(windows, a.mode, a.chrome_pid)
        if found:
            break
        require(time.monotonic() < end, 'Owned native chooser/browser window unavailable within 8s; portal/user windows are forbidden')
        time.sleep(.1)
    require(len(found) == 1, 'Expected exactly one owned chooser/browser window: ' + repr(found))
    target = found[0]
    w, pid = target['window'], target['pid']
    evidence['target'] = target
    if a.mode != 'inspect':
        evidence['phase'] = 'focus-owned-target'
        focus_target(w, pid)
    evidence['phase'] = a.mode
    if a.mode == 'select':
        key(w, pid, 'l', 4)
        actions.append('Ctrl+L')
        time.sleep(.2)
        for char in a.fixture:
            key(w, pid, char, typing_modifiers(char))
        actions.append('type-owned-synthetic-path')
        key(w, pid, 'Return')
        actions.append('Return-navigate-or-select')
        time.sleep(.6)
        # GTK variants may select on the first Return. Never send another key to
        # a destroyed, hidden or reused chooser (nor to the browser behind it).
        windows = owned_windows()
        if any(window['window'] == w and window['dialog'] and window['mapState'] == 'IsViewable' for window in windows):
            key(w, pid, 'Return')
            actions.append('Return-Open/Select')
    elif a.mode == 'cancel':
        key(w, pid, 'Escape')
        actions.append('Escape-native-chooser')
    elif a.mode == 'allow-read':
        key(w, pid, 'Tab')
        actions.append('Tab-assuming-default-Cancel')
        key(w, pid, 'Return')
        actions.append('Return-attempt-read-Allow')
    evidence['phase'] = 'after-' + a.mode
    diagnose()
    print(json.dumps(evidence))
except Exception:
    diagnose()
    raise
finally:
    close_display(d)
