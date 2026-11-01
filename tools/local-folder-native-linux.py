#!/usr/bin/env python3
"""Bounded X11 chooser automation on this test's OWN Xvfb only; no user DISPLAY.

Python stdlib + ctypes/libX11, no xdotool/desktop session/dependencies. No portal
fallback: chooser must belong to the recorded Chrome PID or its Chrome children.
English GTK chooser: Ctrl+L, synthetic absolute path, Return (navigate), Return
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
import stat
import sys
import time
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def proc(pid):
    base = Path('/proc') / str(pid)
    fields = (base / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'ppid': int(fields[1]), 'start': fields[19],
            'args': (base / 'cmdline').read_bytes().split(b'\0'),
            'exe': os.readlink(base / 'exe'), 'uid': base.stat().st_uid}


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
    print(json.dumps({'status': 'passed', 'scope': 'ASCII/named keysyms and Shift masks only; no X11/native runtime'}))
    sys.exit(0)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--display', required=True)
parser.add_argument('--xvfb-pid', type=int, required=True)
parser.add_argument('--chrome-pid', type=int, required=True)
parser.add_argument('--profile', required=True)
parser.add_argument('--ownership', required=True)
parser.add_argument('--mode', choices=['select', 'allow-read', 'cancel'], required=True)
parser.add_argument('--fixture', required=True)
a = parser.parse_args()
require(re.fullmatch(r':\d+', a.display), 'Only a local isolated display number is allowed')
owner = json.loads(Path(a.ownership).read_text())
require(a.fixture in (owner['fixture'], owner['empty']), 'Not an owned fixture')
require(a.profile == owner['profile'], 'Profile ownership mismatch')
require(a.display == owner['linux']['display'], 'Display ownership mismatch')
xvfb, chrome = proc(a.xvfb_pid), proc(a.chrome_pid)
require(xvfb['start'] == owner['linux']['xvfbStart'], 'Xvfb PID identity changed')
require(chrome['start'] == owner['linux']['chromeStart'], 'Chrome PID identity changed')
require(xvfb['uid'] == chrome['uid'] == os.getuid(), 'Process UID mismatch')
require(Path(xvfb['exe']).name == 'Xvfb' and b'-displayfd' in xvfb['args']
        and b'-nolisten' in xvfb['args'] and b'tcp' in xvfb['args'], 'Not our isolated Xvfb')
require(chrome['exe'] == owner['linux']['chromeExe'], 'Chrome executable changed')
require(os.fsencode('--user-data-dir=' + a.profile) in chrome['args'], 'Chrome profile mismatch')
require(os.fsencode('DISPLAY=' + a.display) in
        (Path('/proc') / str(a.chrome_pid) / 'environ').read_bytes().split(b'\0'),
        'Chrome not on our Xvfb')
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
root_window = bind('XDefaultRootWindow', Window, [Display])
query_tree = bind('XQueryTree', C.c_int, [Display, Window, C.POINTER(Window), C.POINTER(Window), C.POINTER(C.POINTER(Window)), C.POINTER(C.c_uint)])
atom = bind('XInternAtom', C.c_ulong, [Display, C.c_char_p, C.c_int])
get_property = bind('XGetWindowProperty', C.c_int, [Display, Window, C.c_ulong, C.c_long, C.c_long, C.c_int, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_ulong), C.POINTER(C.c_ulong), C.POINTER(C.POINTER(C.c_ubyte))])
free = bind('XFree', C.c_int, [C.c_void_p])
flush = bind('XSync', C.c_int, [Display, C.c_int])
set_focus = bind('XSetInputFocus', C.c_int, [Display, Window, C.c_int, C.c_ulong])
get_focus = bind('XGetInputFocus', C.c_int, [Display, C.POINTER(Window), C.POINTER(C.c_int)])
keysym = bind('XStringToKeysym', C.c_ulong, [C.c_char_p])
keycode = bind('XKeysymToKeycode', C.c_uint, [Display, C.c_ulong])


class KeyEvent(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
                ('display', Display), ('window', Window), ('root', Window), ('subwindow', Window),
                ('time', C.c_ulong), ('x', C.c_int), ('y', C.c_int), ('x_root', C.c_int),
                ('y_root', C.c_int), ('state', C.c_uint), ('keycode', C.c_uint), ('same_screen', C.c_int)]


class Event(C.Union):
    _fields_ = [('key', KeyEvent), ('pad', C.c_long * 24)]


send = bind('XSendEvent', C.c_int, [Display, Window, C.c_int, C.c_long, C.POINTER(Event)])
d = open_display(a.display.encode())
require(d, 'Owned Xvfb display unavailable (never falling back to user DISPLAY)')
root = root_window(d)
actions = []


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


def children(w):
    r, parent, count, data = Window(), Window(), C.c_uint(), C.POINTER(Window)()
    require(query_tree(d, w, C.byref(r), C.byref(parent), C.byref(data), C.byref(count)), 'X11 tree read failed')
    try:
        return list(data[:count.value])
    finally:
        if data:
            free(data)


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


def candidates():
    found = []
    for w in children(root):
        pids = property_value(w, '_NET_WM_PID')
        if not pids or not owned(pids[0]):
            continue
        role = property_value(w, 'WM_WINDOW_ROLE') or ''
        title = property_value(w, '_NET_WM_NAME') or property_value(w, 'WM_NAME') or ''
        transient = property_value(w, 'WM_TRANSIENT_FOR')
        types = property_value(w, '_NET_WM_WINDOW_TYPE') or []
        dialog = (atom(d, b'_NET_WM_WINDOW_TYPE_DIALOG', 0) in types
                  or 'file' in role.lower() or bool(transient))
        # Chrome's main top-level is not a native GTK file chooser.
        if a.mode in ('select', 'cancel') and dialog:
            found.append((w, pids[0], role, title))
        if a.mode == 'allow-read' and not dialog and 'Code City synthetic native qualification' in title:
            found.append((w, pids[0], role, title))
    return found


def verify_window(w, pid):
    require(proc(a.chrome_pid)['start'] == chrome['start'], 'Chrome identity changed')
    require(proc(a.xvfb_pid)['start'] == xvfb['start'], 'Xvfb identity changed')
    require(owned(pid) and property_value(w, '_NET_WM_PID') == [pid], 'Window process ownership changed')


def focus_target(w, pid):
    verify_window(w, pid)
    set_focus(d, w, 1, 0)  # Only on the independently created Xvfb, never user's display.
    flush(d, 0)
    focused, revert = Window(), C.c_int()
    get_focus(d, C.byref(focused), C.byref(revert))
    require(focused.value == w, 'Could not focus the owned Xvfb window')


def key(w, pid, name, modifiers=0):
    verify_window(w, pid)
    code = keycode(d, key_symbol(name, keysym))
    require(code != 0, 'Key unavailable on isolated X11 keyboard: ' + name)
    for event_type, mask in ((2, 1), (3, 2)):
        event = Event()
        event.key = KeyEvent(event_type, 0, 1, d, w, root, 0, 0, 1, 1, 1, 1, modifiers, code, 1)
        require(send(d, w, 1, mask, C.byref(event)), 'Scoped XSendEvent failed')
    flush(d, 0)


try:
    end = time.monotonic() + 8
    while True:
        found = candidates()
        if found:
            break
        require(time.monotonic() < end, 'Owned native chooser/browser window unavailable within 8s; portal/user windows are forbidden')
        time.sleep(.1)
    require(len(found) == 1, 'Expected exactly one owned chooser/browser window: ' + repr(found))
    w, pid, role, title = found[0]
    focus_target(w, pid)
    if a.mode == 'select':
        key(w, pid, 'l', 4)  # ControlMask
        time.sleep(.2)
        for char in a.fixture:
            key(w, pid, char, typing_modifiers(char))
        key(w, pid, 'Return')
        time.sleep(.6)
        actions = ['Ctrl+L', 'type-owned-synthetic-path', 'Return-navigate-or-select']
        # GTK variants may accept an absolute directory on the first Return.
        # Never send the second key to a now-destroyed/reused chooser window.
        if w in children(root):
            key(w, pid, 'Return')
            actions.append('Return-Open/Select')
    elif a.mode == 'cancel':
        key(w, pid, 'Escape')
        actions = ['Escape-native-chooser']
    else:
        key(w, pid, 'Tab')
        key(w, pid, 'Return')
        actions = ['Tab-from-default-Cancel', 'Return-read-Allow']
    print(json.dumps({'display': a.display, 'xvfbPid': a.xvfb_pid, 'chromePid': a.chrome_pid,
                      'window': w, 'windowPid': pid, 'role': role, 'title': title,
                      'mode': a.mode, 'actions': actions}))
finally:
    close_display(d)
