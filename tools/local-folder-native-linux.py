#!/usr/bin/env python3
"""Bounded X11 chooser automation on this test's OWN Xvfb only; no user DISPLAY.

Qualification-only Python stdlib + ctypes/libX11/libXtst; no user desktop APIs.
No portal fallback: chooser must belong to the recorded Chrome PID or its children.
English GTK chooser: real XTEST Ctrl+L/Ctrl+A, exact synthetic directory with
trailing slash, Tab out of completion, explicit Alt+O Open. Chrome's read prompt:
Tab from default Cancel, Return; the driver still requires the actual granted handle.
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
        # Read-only identity observations are not focus/key targets.
        self.evidence, self.targets, self.action_targets = evidence, {}, set()

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
        browser_windows = [window for window in top if self.window_pids(window, enumeration=True) == [chrome['pid']]]
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

    def prepare_action(self, w, pid):
        self.verify(w, pid)
        # Keep every previous/current action target protected, including reused XIDs.
        self.action_targets.add((w, pid))

    def act(self, w, pid, action):
        self.prepare_action(w, pid)
        return action()


class ScopedServerGrab:
    """One nesting counter for metadata snapshots and segmented keyboard grabs.

    XGrabServer itself is not refcounted. An inner metadata scan must never
    release an outer keyboard segment's grab. Every acquire needs fresh positive
    process/connected-server proof; callers sync in finally after release.
    """
    def __init__(self, scope, grab, ungrab, sync):
        self.scope, self.grab, self.ungrab, self.sync = scope, grab, ungrab, sync
        self.depth = 0

    def acquire(self):
        self.scope.server()
        if self.depth == 0:
            self.grab()
        self.depth += 1

    def release(self):
        require(self.depth > 0, 'Unbalanced owned X11 server ungrab')
        self.depth -= 1
        if self.depth == 0:
            self.ungrab()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, _kind, _error, _traceback):
        try:
            self.release()
        finally:
            self.sync()


def scoped_key(scope, w, pid, codes, emit, grab, ungrab, sync, focus, release_focus):
    """Verified segments on our server only; never a system-wide keyboard API.

    Ungrab + XSync between modifier transitions and the primary pair lets GTK
    issue X requests while modifiers are held. Whole-chord grabs block those
    requests; whether that caused the CI shortcut failure remains unproven.
    Keep primary down/up under ONE grab: Return may destroy its target as soon
    as GTK runs. Every segment and paired release needs fresh ownership/focus
    proof. Lost proof forbids cleanup input; private Xvfb teardown clears keys.
    """
    require(codes and len(set(codes)) == len(codes), 'Empty/ambiguous owned chord')
    initial, held = True, []

    def segment(action):
        nonlocal initial
        scope.verify(w, pid)
        grab()
        try:
            scope.prepare_action(w, pid)
            (focus if initial else release_focus)()
            initial = False  # keyboard-empty check only before this chord starts
            action()
        finally:
            try:
                ungrab()
            finally:
                sync()  # actually flush the ungrab before the next segment

    def press_modifier(code):
        held.append(code)  # clean up even an emit that raises after queueing
        require(emit(code, True), 'Owned XTEST key press failed')

    def primary_pair():
        try:
            require(emit(codes[-1], True), 'Owned XTEST key press failed')
        finally:
            scope.verify(w, pid)
            release_focus()
            require(emit(codes[-1], False), 'Owned XTEST key release failed')

    try:
        for code in codes[:-1]:
            segment(lambda code=code: press_modifier(code))
        segment(primary_pair)
    finally:
        errors = []
        for code in reversed(held):
            try:
                segment(lambda code=code: require(emit(code, False), 'Owned XTEST key release failed'))
            except Exception as error:
                errors.append(error)
        if errors:
            raise errors[0]


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


class X11RequestError(RuntimeError):
    """A failed request must remain fatal even in optional image diagnostics."""


def flush(display, discard):
    x_sync(display, discard)
    if x_errors:
        evidence['xErrors'] = list(x_errors)
        x_errors.clear()
        raise X11RequestError('Owned X11 request failed: ' + json.dumps(evidence['xErrors']))


def checked_property_request(w, name, enumeration, action_targets, request, sync, collect,
                             errors, root_children, evidence):
    """Retirement is a terminal negative enumeration result, never ownership proof.

    Fence old errors before this request and collect its errors synchronously so
    a closed GTK completion popup cannot poison the next key flush. Only a
    never-acted top-level PID candidate may retire, even if observed read-only,
    after one fresh root query proves absence (a live/reused ID fails). No retry,
    action-target or focus exemption; retirement never proves ownership.
    """
    sync()  # Old/other queued errors must fail outside this request's exception.
    status = request()
    collect()
    observed = list(errors)
    if status == 0 and not observed:
        return True
    # libX11 GetProp.c returns generic 1 on failed _XReply, including BadWindow.
    # That status alone is NOT proof: require the exact handler error as well.
    eligible = (enumeration and name == '_NET_WM_PID'
                and not any(window == w for window, _pid in action_targets)
                and status in (0, 1, 3)
                and observed == [{'code': 3, 'request': 20, 'resource': w}])
    if eligible:
        present = root_children()  # Proof only: do not rerun enumeration/work.
        collect()  # Root-query errors must also remain fatal.
        if w not in present and errors == observed:
            errors.clear()  # Consume ONLY the exact error whose absence was proved.
            evidence.setdefault('retiredUnknownCandidates', []).append(w)
            return False
    if errors:
        evidence['xErrors'] = list(errors)
    raise X11RequestError('Owned X11 property request failed: ' + json.dumps(
        {'window': w, 'property': name, 'status': status, 'errors': list(errors)}))


def scoped_diagnostic(image, sync, evidence):
    try:
        image()
    except X11RequestError:
        raise
    except Exception as error:
        evidence['diagnosticError'] = str(error)
    finally:
        # Optional image failures may be reported, never pending X11 errors.
        # Also fail after the final diagnostic when there is no next key flush.
        sync()


def typing_modifiers(char):
    return 1 if char.isupper() or char == '_' else 0


def chord_names(name, modifiers):
    require(modifiers in (0, 1, 4, 8), 'Unsupported XTEST modifiers')
    return ({0: [], 1: ['Shift_L'], 4: ['Control_L'], 8: ['Alt_L']}[modifiers] + [name])


if sys.argv[1:] == ['--self-test']:
    for char in '/tmp/CodeCitySynthetic-a_b.123':
        require(key_symbol(char, lambda _: 0) == ord(char), 'ASCII keysym regression')
    require(key_symbol('Return', lambda name: 0xff0d if name == b'Return' else 0) == 0xff0d,
            'Named keysym regression')
    require([typing_modifiers(c) for c in 'C_/-az'] == [1, 1, 0, 0, 0, 0], 'Shift-mask regression')
    require(chord_names('o', 8) == ['Alt_L', 'o'], 'Explicit Open mnemonic regression')
    require(chord_names('l', 4) == ['Control_L', 'l'], 'Location chord regression')
    require(chord_names('C', 1) == ['Shift_L', 'C'] and chord_names('/', 0) == ['/'], 'Typing chord regression')
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

    # Exercise the production request boundary, including delayed Xlib delivery.
    # These are synthetic callbacks, not X11/GUI qualification.
    bad_candidate = {'code': 3, 'request': 20, 'resource': 599}

    def property_case(status=3, name='_NET_WM_PID', enumeration=True, action_targets=None,
                      reported=None, present=(), prior=(), proof_errors=(), proof_fails=False):
        pending, trace, proof = list(prior), [], {}
        deliveries = [list([bad_candidate] if reported is None else reported), list(proof_errors)]

        def sync():
            trace.append('sync')
            require(not pending, 'Prior queued X11 error')

        def request():
            trace.append('request')
            return status

        def collect():
            trace.append('collect')
            pending.extend(deliveries.pop(0))

        def root_children():
            trace.append('root-proof')
            require(not proof_fails, 'Root query failed')
            return list(present)

        def run():
            return checked_property_request(599, name, enumeration, action_targets or set(), request,
                                            sync, collect, pending, root_children, proof)
        return run, pending, trace, proof, sync

    for status in (0, 1, 3):  # libX11's generic _XReply failure still needs full proof.
        run, pending, trace, proof, sync = property_case(status=status)
        require(run() is False and not pending and proof == {'retiredUnknownCandidates': [599]},
                'Exact absent unknown PID candidate must retire, never qualify')
        require(trace == ['sync', 'request', 'collect', 'root-proof', 'collect'],
                'Retirement needs synchronous request errors and one fresh absence proof, no retry')
        sync()  # The consumed error must not leak into the next key's flush.
    run, pending, trace, proof, sync = property_case(status=0, reported=[])
    require(run() is True and trace == ['sync', 'request', 'collect'] and not proof,
            'Successful property read changed or performed unnecessary presence work')
    for change in [
            {'enumeration': False}, {'name': 'WM_NAME'}, {'name': 'WM_TRANSIENT_FOR'},
            {'action_targets': {(599, 102)}}, {'action_targets': {(599, 999)}},
            {'name': '_net_wm_pid'}, {'name': '_NET_WM_PID '},
            {'status': 0, 'reported': [{**bad_candidate, 'code': 2}]},
            {'status': 1, 'reported': [{**bad_candidate, 'request': 3}]},
            {'status': 1, 'reported': [{**bad_candidate, 'resource': 598}]},
            {'present': [501, 599]},  # extant/reused XID, regardless of PID
            {'status': 2}, {'status': 9}, {'status': 1, 'reported': []}, {'status': 3, 'reported': []},
            {'status': 1, 'reported': [{**bad_candidate, 'code': 2}]},
            {'reported': [{**bad_candidate, 'code': 2}]},
            {'reported': [{**bad_candidate, 'request': 3}]},
            {'reported': [{**bad_candidate, 'resource': 598}]},
            {'reported': [bad_candidate, bad_candidate]},
            {'reported': [bad_candidate, {'code': 99, 'request': 20, 'resource': 599}]},
            {'proof_errors': [{'code': 3, 'request': 15, 'resource': 1}]},
            {'proof_fails': True}, {'prior': [bad_candidate]}]:
        run, pending, trace, proof, sync = property_case(**change)
        refuses(run)
        require('retiredUnknownCandidates' not in proof, 'Invalid property error was waived')
        require(trace.count('request') <= 1 and trace.count('root-proof') <= 1,
                'Property failure retried enumeration or presence proof')
        if change.get('prior'):
            require(trace == ['sync'], 'Prior queued error was attributed to candidate request')
        elif not change.get('reported') == []:
            require(pending, 'Fatal property error was consumed')
    # Optional diagnostics must not swallow a failed property status or leave
    # queued X errors to be ignored after the final image (no next key).
    for change in [{'status': 3, 'reported': []}, {'present': [599]}]:
        run, pending, trace, proof, sync = property_case(**change)
        refuses(lambda: scoped_diagnostic(run, sync, proof))
        require('diagnosticError' not in proof, 'Fatal property request treated as optional image failure')
    for queued in (False, True):
        proof = {}
        def failed_image():
            raise RuntimeError('Optional PNG unavailable')
        def image_sync():
            require(not queued, 'Queued X11 error after final diagnostic')
        if queued:
            refuses(lambda: scoped_diagnostic(failed_image, image_sync, proof))
        else:
            scoped_diagnostic(failed_image, image_sync, proof)
            require(proof == {'diagnosticError': 'Optional PNG unavailable'}, 'Optional image error became fatal')
    # Use production flush itself: it clears the queue before raising. An image
    # wrapper that catches that fatal exception would see an empty final flush.
    for deferred in (False, True):
        for during_property in (False, True):
            evidence = {}
            unexpected = {'code': 2, 'request': 20, 'resource': 599}
            x_errors = [] if deferred else [unexpected]
            delivery = [unexpected] if deferred else []
            def x_sync(_display, _discard):
                x_errors.extend(delivery)
                delivery.clear()
            def fatal_image():
                if during_property:
                    checked_property_request(599, '_NET_WM_PID', True, {},
                                             lambda: require(False, 'Request after prior X error'),
                                             lambda: flush(None, 0), lambda: x_sync(None, 0),
                                             x_errors, lambda: [], evidence)
                else:
                    flush(None, 0)
            refuses(lambda: scoped_diagnostic(fatal_image, lambda: flush(None, 0), evidence))
            require(not x_errors and evidence == {'xErrors': [unexpected]},
                    'Cleared fatal X11 error became an optional diagnostic failure')
    # An unrelated proven target does not prevent retirement of this unknown ID.
    run, pending, trace, proof, sync = property_case(action_targets={(502, 102)})
    require(run() is False and not pending, 'Unrelated managed target blocked negative enumeration')

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
                         lambda: state['peer'], lambda: state['top'], lambda w, enumeration=False: state['pids'].get(w),
                         lambda pid: state['chrome'] if pid == 101 else state['target'],
                         lambda pid: state['owned'] and pid in (101, 102), evidence)

    # Reproduce CI's read-only verified completion popup, not just an unknown ID.
    guard = reset()
    state['top'].append(599)
    state['pids'][599] = [102]
    guard.verify(599, 102)
    observed = dict(guard.targets)
    require((599, 102) in observed and not guard.action_targets,
            'Read-only verification incorrectly claimed an action target')
    run, pending, trace, proof, sync = property_case(status=1, action_targets=guard.action_targets)
    require(run() is False and not pending and proof == {'retiredUnknownCandidates': [599]},
            'Previously observed never-acted popup failed exact negative retirement')
    require(guard.targets == observed and not guard.action_targets,
            'Retirement claimed ownership or promoted a read-only observation')
    guard.act(599, 102, lambda: sent.append('popup-focus'))
    guard.act(502, 102, lambda: sent.append('chooser-focus'))
    run, pending, trace, proof, sync = property_case(status=1, action_targets=guard.action_targets)
    refuses(run)
    require(pending and not proof.get('retiredUnknownCandidates')
            and guard.action_targets == {(599, 102), (502, 102)},
            'A previous action target was retired after focus moved elsewhere')

    # Verify's independent browser-root enumeration must use the same guarded
    # negative PID read. Actual target reads never receive that exemption.
    for observed_popup, acted_popup, target_popup in [(False, False, False), (True, False, False),
                                                       (True, True, False), (False, False, True)]:
        guard = reset()
        state['top'].append(599)
        state['pids'][599] = [102]
        if observed_popup:
            guard.verify(599, 102)
        if acted_popup:
            guard.act(599, 102, lambda: None)
        calls = []
        def disappearing_pid(window, enumeration=False):
            calls.append((window, enumeration))
            if window == 599:
                run, pending, trace, proof, sync = property_case(
                    status=1, enumeration=enumeration, action_targets=guard.action_targets)
                require(run() is False, 'Retired popup must produce only negative PID evidence')
                return None
            return state['pids'].get(window)
        guard.window_pids = disappearing_pid
        if acted_popup or target_popup:
            refuses(lambda: guard.verify(599 if target_popup else 502, 102))
            require(not evidence['displayProof']['displayQualified'], 'Retirement falsely qualified target ownership')
        else:
            guard.verify(502, 102)
            require(evidence['displayProof']['window'] == 502 and not guard.action_targets,
                    'Negative popup read changed the verified target')
            if not observed_popup:
                require((599, 102) not in guard.targets, 'Retirement cached popup ownership')
        require((599, True) in calls, 'Browser-window enumeration bypassed guarded PID retirement')
        if target_popup:
            require((599, False) in calls, 'Actual target PID read used enumeration exemption')

    for env in [b'', b'DISPLAY=\0', b'DISPLAY=:7\0']:
        guard = reset()
        state['env'] = env
        require('displayProof' not in evidence, 'Process binding must not qualify display')
        guard.act(502, 102, lambda: sent.append('focus'))
        guard.act(502, 102, lambda: sent.append('key'))
        require(sent == ['focus', 'key'] and evidence['displayProof']['displayQualified']
                and guard.action_targets == {(502, 102)}, 'Positive X11 action proof/registration rejected')
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
        require(not sent and not evidence['displayProof']['displayQualified'] and not guard.action_targets,
                'Failed proof emitted input or claimed an action target')
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
    # The same refcounted production lock serves metadata and keyboard segments.
    # No native X server is opened: assertions concern orchestration only.
    def test_grab(guard, trace, failed=None):
        def event(name):
            trace.append(name)
            require(name != failed, 'Injected ' + name + ' failure')
        return ScopedServerGrab(guard, lambda: event('grab'), lambda: event('ungrab'), lambda: event('sync'))

    for inner_error in (False, True):
        guard, trace = reset(), []
        lock = test_grab(guard, trace)
        def snapshot():
            with lock:
                require(lock.depth == 2, 'Metadata did not nest in existing keyboard lock')
                require(not inner_error, 'Injected metadata failure')
        with lock:
            if inner_error:
                refuses(snapshot)
            else:
                snapshot()
            require(lock.depth == 1 and 'ungrab' not in trace,
                    'Metadata released a preexisting outer keyboard grab')
        require(lock.depth == 0 and trace == ['grab', 'sync', 'ungrab', 'sync'],
                'Nested snapshot grab/ungrab/finally-sync imbalance')
    for failed in ('metadata', 'ungrab', 'sync'):
        guard, trace = reset(), []
        lock = test_grab(guard, trace, failed)
        def failed_snapshot():
            with lock:
                require(failed != 'metadata', 'Injected metadata failure')
        refuses(failed_snapshot)
        require(lock.depth == 0 and trace == ['grab', 'ungrab', 'sync'],
                'Failed snapshot leaked grab or skipped final sync')
        refuses(lock.release)
    guard, trace = reset(), []
    lock = test_grab(guard, trace)
    state['peer'] = (91, 42)
    refuses(lock.acquire)
    require(lock.depth == 0 and not trace, 'Unproved connected server was grabbed')
    state['peer'] = (90, 42)
    with lock:
        state['peer'] = (91, 42)
        refuses(lock.acquire)
        require(lock.depth == 1 and trace == ['grab'], 'Failed nested proof changed outer lock')
    require(trace == ['grab', 'ungrab', 'sync'] and lock.depth == 0, 'Failed nested proof leaked outer lock')

    # Exercise pure scoped_key orchestration; no X11 calls or mock success claims.
    def chord(guard, emit=None, focus=lambda: None, release_focus=lambda: None,
              codes=(37, 46), grab=None, sync=None):
        scoped_key(guard, 502, 102, codes, emit or (lambda code, down: sent.append((code, down)) or 1),
                   grab or (lambda: sent.append('grab')), lambda: sent.append('ungrab'),
                   sync or (lambda: sent.append('sync')), focus, release_focus)

    def events():
        return [event for event in sent if isinstance(event, tuple)]

    guard, trace = reset(), []
    lock = test_grab(guard, trace)
    def metadata_during_key():
        require(lock.depth == 1, 'Focus/metadata check is outside keyboard grab')
        with lock:
            require(lock.depth == 2, 'Keyboard metadata scan did not share grab depth')
        require(lock.depth == 1 and trace.count('grab') == trace.count('ungrab') + 1,
                'Nested metadata ungrabbed active keyboard segment')
    scoped_key(guard, 502, 102, [37, 46], lambda code, down: sent.append((code, down)) or 1,
               lock.acquire, lock.release, lock.sync, metadata_during_key, metadata_during_key)
    require(lock.depth == 0 and trace.count('grab') == trace.count('ungrab') == 3
            and guard.action_targets == {(502, 102)},
            'Keyboard lost segmentation, shared-lock balance or action-target registration')

    guard = reset()
    # Assert the full verification/grab/focus/input/ungrab/sync order, including
    # exactly one initial keyboard-empty callback and paired-release rechecks.
    verify = guard.verify
    def traced_verify(w, pid):
        sent.append('verify')
        verify(w, pid)
    guard.verify = traced_verify
    chord(guard, focus=lambda: sent.append('initial-empty'), release_focus=lambda: sent.append('release-focus'),
          codes=(37, 50, 46))
    start = ['verify', 'grab', 'verify']
    end = ['ungrab', 'sync']
    require(sent == [*start, 'initial-empty', (37, True), *end,
                     *start, 'release-focus', (50, True), *end,
                     *start, 'release-focus', (46, True), 'verify', 'release-focus', (46, False), *end,
                     *start, 'release-focus', (50, False), *end,
                     *start, 'release-focus', (37, False), *end],
            'Segments must independently verify; primary pair atomic; modifiers reverse-released')
    guard = reset()
    chord(guard, codes=(36,))
    require(sent == ['grab', (36, True), (36, False), 'ungrab', 'sync'],
            'Terminal Return down/up must remain under one grab')
    for failing in [(37, True), (50, True), (46, True), (46, False), (50, False), (37, False)]:
        for raises in (False, True):
            guard = reset()
            def fail_emit(code, down):
                sent.append((code, down))
                if (code, down) == failing:
                    if raises:
                        raise RuntimeError('injected XTEST failure after queueing')
                    return 0
                return 1
            refuses(lambda: chord(guard, fail_emit, codes=(37, 50, 46)))
            expected = [(37, True)]
            if failing != (37, True):
                expected.append((50, True))
                if failing != (50, True):
                    expected.extend([(46, True), (46, False)])
                expected.append((50, False))
            expected.append((37, False))
            require(events() == expected and sent[-2:] == end, 'Failed emit leaked a key/grab or retried input')
    for change in [{'peer': (91, 42)}, {'pids': {501: [101], 502: [999]}}, {'top': [502]}]:
        guard = reset()
        state.update(change)
        refuses(lambda: chord(guard))
        require(not sent, 'Unproved server/window received part of a chord')
    guard = reset()
    refuses(lambda: chord(guard, focus=lambda: require(False, 'wrong focus')))
    require(sent == ['grab', 'ungrab', 'sync'], 'Focus refusal emitted keys or leaked grab')
    # Simulate focus loss at every later guard, including the paired release.
    for lost_at in (1, 2, 3):
        guard = reset()
        calls = [0]
        def later_focus():
            calls[0] += 1
            require(calls[0] < lost_at, 'injected persistent wrong focus')
        refuses(lambda: chord(guard, release_focus=later_focus))
        require(events() == ([(37, True), (46, True)] if lost_at == 2 else
                              [(37, True), (46, True), (46, False)] if lost_at == 3 else [(37, True)]),
                'Wrong focus received input or unchecked release')
        require(sent[-2:] == end, 'Focus refusal leaked grab')
    # Fresh server proof inside EVERY grab, not just before the whole chord.
    for grab_number in (1, 2, 3):
        guard = reset()
        grabs = [0]
        def changed_at_grab():
            sent.append('grab')
            grabs[0] += 1
            if grabs[0] == grab_number:
                state['peer'] = (91, 42)
        refuses(lambda: chord(guard, grab=changed_at_grab))
        require(events() == ([(37, True), (46, True), (46, False)] if grab_number == 3 else
                              [(37, True)] if grab_number == 2 else []),
                'Proof not refreshed inside segment grab')
        require(sent[-2:] == end, 'Post-grab refusal leaked grab')
    # Identity/focus can change while GTK runs BETWEEN segments, or after the
    # primary down before paired up. Never emit cleanup on a lost proof.
    for change in [{'peer': (91, 42)}, {'top': [501]}, {'top': [502]},
                   {'pids': {501: [101], 502: [999]}},
                   {'target': {**chrome, 'pid': 102, 'start': '999'}},
                   {'chrome': {**chrome, 'exe': '/wrong'}}, {'xvfb': {**xvfb, 'uid': 43}},
                   {'env': b'DISPLAY=:70\0'}]:
        for boundary in ('between', 'paired-release'):
            guard = reset()
            def lost_proof_emit(code, down):
                sent.append((code, down))
                if boundary == 'paired-release' and (code, down) == (46, True):
                    state.update(change)
                return 1
            def between_sync():
                sent.append('sync')
                if boundary == 'between':
                    state.update(change)
            refuses(lambda: chord(guard, lost_proof_emit, sync=between_sync))
            require(events() == ([(37, True)] if boundary == 'between' else [(37, True), (46, True)]),
                    'Lost server/browser/target proof received unchecked input/release')
            require(sent[-2:] == end, 'Lost proof leaked grab')
    guard = reset()
    def failed_sync():
        sent.append('sync')
        raise RuntimeError('injected sync failure')
    refuses(lambda: chord(guard, sync=failed_sync))
    require(events() == [(37, True), (37, False)] and sent[-2:] == end,
            'Sync failure must still attempt verified modifier cleanup')
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
    print(json.dumps({'status': 'passed', 'scope': 'synthetic process ownership, exact profile bytes, full flattened argv/spoof refusals, DISPLAY contradiction/source guards and DISPLAY-only evidence; empty metadata defers to exact connected-Xvfb/CDP top-level window proof; focus/key action boundary and identity rechecks; raw/empty argv preservation, ASCII/named keysyms and Shift masks; viewable map states, segmented XTEST grab/verification/initial-empty ordering, atomic primary pair, reverse modifier cleanup, press/release/sync failures, between-segment/paired-release lost-proof refusal, exact/descendant focus refusals and chooser-before-Allow guard; read-only observations separated from permanent focus/key action targets; synchronous PID-enumeration never-acted candidate retirement with fresh absence proof, queued-error isolation, previous/current action-target/live-or-reused-XID/other-property/status/code/request/resource/mixed-error/root-proof refusals, independent browser enumeration and strict actual-target PID guards; shared nested metadata/keyboard server-grab balance, proof and error cleanup; optional-image boundary preserves fatal property/queued errors, including after the final diagnostic; no X11/native runtime'}))
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


def property_value(w, name, enumeration=False):
    actual, fmt, count, after = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong()
    data = C.POINTER(C.c_ubyte)()
    property_atom = atom(d, name.encode(), 0)
    try:
        if not checked_property_request(
                w, name, enumeration, scope.action_targets,
                lambda: get_property(d, w, property_atom, 0, 1024, 0, 0,
                                     C.byref(actual), C.byref(fmt), C.byref(count), C.byref(after), C.byref(data)),
                lambda: flush(d, 0), lambda: x_sync(d, 0), x_errors,
                lambda: children(root), evidence):
            return None
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
    # Freeze the entire root list + PID/map/role/title scan, not just each read:
    # GTK can otherwise destroy an observed popup between metadata requests.
    # This context also nests safely inside allow-read's keyboard segment.
    with server_grab:
        found = []
        for w in children(root):
            pids = property_value(w, '_NET_WM_PID', enumeration=True)
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
                  lambda: children(root), lambda w, enumeration=False: property_value(w, '_NET_WM_PID', enumeration),
                  proc, owned, evidence)
server_grab = ScopedServerGrab(scope, lambda: grab_server(d), lambda: ungrab_server(d), lambda: flush(d, 0))


def require_focus(w, pid):
    focused, revert = Window(), C.c_int()
    get_focus(d, C.byref(focused), C.byref(revert))
    verified_focus(w, focused.value, lambda child: window_tree(child)[0],
                   lambda child: property_value(child, '_NET_WM_PID'), window_map_state, pid)
    evidence['focus'] = {'target': w, 'actual': focused.value, 'verifiedDescendant': focused.value != w}


def focus_target(w, pid):
    scope.verify(w, pid)
    with server_grab:
        scope.prepare_action(w, pid)
        require_viewable(window_map_state(w))
        set_focus(d, w, 1, 0)
        flush(d, 0)
        require_focus(w, pid)


def key(w, pid, name, modifiers=0):
    names = chord_names(name, modifiers)
    codes = [keycode(d, key_symbol(n, keysym)) for n in names]
    require(all(codes) and len(set(codes)) == len(codes), 'Key unavailable/ambiguous on isolated X11 keyboard: ' + name)
    def release_focus():
        require_focus(w, pid)
        if a.mode == 'allow-read':
            require_chooser_closed(owned_windows())  # recheck under grab before EVERY segment/release
    def focus():
        release_focus()
        keymap = (C.c_ubyte * 32)()
        query_keymap(d, keymap)
        require(not any(keymap), 'Owned Xvfb already has depressed keys; refusing input')
    scoped_key(scope, w, pid, codes, lambda code, down: fake_key(d, code, int(down), 0),
               server_grab.acquire, server_grab.release, lambda: flush(d, 0),
               focus, release_focus)
    evidence['input']['chordsCompleted'] += 1
    evidence['input']['lastKey'] = name


# Minimal diagnostic image: only this already-proved private Xvfb root. No desktop,
# filesystem/source inspection or profile contents. Downsample to bound work/size.
def diagnostic_png(suffix=''):
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
        image_path = a.diagnostic_png.removesuffix('.png') + suffix + '.png'
        with open(image_path, 'xb') as output:
            output.write(png)
        evidence['diagnosticPng'] = image_path
        evidence.setdefault('diagnosticPngs', []).append(image_path)
    finally:
        destroy_image(image)


def diagnose(suffix=''):
    scoped_diagnostic(lambda: diagnostic_png(suffix), lambda: flush(d, 0), evidence)


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
        key(w, pid, 'a', 4)  # Replace the remembered directory, never append another absolute path.
        actions.append('Ctrl+A-replace-location')
        diagnose('-after-location')  # Ctrl+L result BEFORE any path typing, not shortcut success proof.
        # A trailing slash identifies the exact directory, not a completion
        # prefix also matching our sibling '-empty' fixture.
        for char in a.fixture + '/':
            key(w, pid, char, typing_modifiers(char))
        actions.append('type-owned-synthetic-path')
        key(w, pid, 'Tab')  # Leave the completion popup before activating the dialog's _Open.
        actions.append('Tab-leave-location-completion')
        if a.fixture == owner['fixture']:
            # This controlled main fixture has child directories: GTK opens its
            # location completion list. Dismiss that list, not the chooser.
            # The empty fixture has no directory completions and must not receive Escape.
            key(w, pid, 'Escape')
            actions.append('Escape-main-fixture-location-completion')
        diagnose('-before-confirm')  # Actual owned chooser state, not an inferred default button.
        # GTK's default response may be Cancel. Activate its explicit English
        # _Open action, not an inferred Return/default-button selection.
        key(w, pid, 'o', 8)
        actions.append('Alt+O-explicit-Open')
        time.sleep(.6)
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
