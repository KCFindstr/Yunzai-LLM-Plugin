import base64
import io
import ipaddress
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
from supervisor import ProcessSupervisor

os.environ['DISPLAY'] = ':99'
os.environ['HOME'] = '/home/pc'
os.environ['XDG_RUNTIME_DIR'] = '/tmp/runtime-pc'
os.makedirs('/tmp/runtime-pc', mode=0o700, exist_ok=True)
os.chdir('/work')


def start(argv):
    return subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


display = start(['Xvfb', ':99', '-screen', '0', '1024x768x24', '-nolisten', 'tcp', '-ac'])
for attempt in range(100):
    if os.path.exists('/tmp/.X11-unix/X99'):
        break
    time.sleep(0.1)
start(['dbus-launch', '--exit-with-session', 'openbox-session'])
time.sleep(0.6)
start(['feh', '--bg-fill', '/home/pc/wallpaper.png'])
subprocess.run(['xrdb', '-merge', '/home/pc/.Xresources'], check=False)
start(['tint2'])
start(['xterm', '-geometry', '32x9+32+430', '-title', '像素终端 · ピクセル端末'])
# Optional remote viewer shares this exact display and namespace; no second desktop is created.
rustdesk = ProcessSupervisor(['python3', '/usr/local/lib/llm-desktop/rustdesk-launch.py'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def supervise_rustdesk():
    if pathlib.Path('/home/pc/.config/llm-desktop/rustdesk-enabled').is_file() and pathlib.Path('/usr/local/lib/llm-desktop/rustdesk-launch.py').is_file():
        rustdesk.tick()


supervise_rustdesk()
chrome = pathlib.Path('/usr/local/lib/llm-desktop/chrome-path').read_text().strip()
chrome_arguments = [chrome, '--disable-dev-shm-usage', '--no-first-run', '--disable-features=Translate',
       '--password-store=basic', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223',
       '--user-data-dir=/home/pc/browser', '--window-size=980,680', '--window-position=20,35', 'about:blank']


def start_browser():
    # Retain native Chrome diagnostics instead of discarding evidence of crashes.
    log = pathlib.Path('/home/pc/.config/llm-desktop/chrome.log')
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists() and log.stat().st_size > 4 * 1024 * 1024:
        log.replace(log.with_suffix('.previous.log'))
    with log.open('a') as output:
        return subprocess.Popen(chrome_arguments, stdout=output, stderr=output, start_new_session=True)


browser_process = start_browser()

import pyautogui
import pyperclip
import websocket

pyperclip.set_clipboard('xclip')
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.06
active_target = None


def image(crop=None):
    shot = pyautogui.screenshot()
    if crop is not None:
        if not isinstance(crop, list) or len(crop) != 4:
            raise ValueError('crop must be [x,y,width,height]')
        left, top, width, height = [int(value) for value in crop]
        if left < 0 or top < 0 or width < 1 or height < 1 or left + width > 1024 or top + height > 768:
            raise ValueError('crop outside desktop')
        shot = shot.crop((left, top, left + width, top + height))
    output = io.BytesIO()
    shot.save(output, 'PNG', optimize=True)
    return {'mime': 'image/png', 'data': base64.b64encode(output.getvalue()).decode(), 'width': shot.width, 'height': shot.height}


def public_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('only public HTTP(S) URLs without credentials are allowed')
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80))
    if any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise ValueError('private destinations are not allowed')
    return value


def cdp(endpoint, method, params=None):
    connection = websocket.create_connection(endpoint, timeout=12, suppress_origin=True)
    try:
        connection.send(json.dumps({'id': 1, 'method': method, 'params': params or {}}))
        while True:
            result = json.loads(connection.recv())
            if result.get('id') == 1:
                if result.get('error'):
                    raise ValueError(result['error']['message'])
                return result.get('result', {})
    finally:
        connection.close()


def browser(url=None):
    global active_target, browser_process
    if browser_process.poll() is not None:
        browser_process = start_browser()
        active_target = None
    for attempt in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:9223/json/version', timeout=1) as response:
                browser_endpoint = json.load(response)['webSocketDebuggerUrl']
            break
        except OSError:
            time.sleep(0.2)
    else:
        raise ValueError('browser not ready; inspect desktop or restart llm-desktop')
    if url:
        public_url(str(url))
        active_target = cdp(browser_endpoint, 'Target.createTarget', {'url': url})['targetId']
        cdp(browser_endpoint, 'Target.activateTarget', {'targetId': active_target})
        time.sleep(2)
    with urllib.request.urlopen('http://127.0.0.1:9223/json', timeout=5) as response:
        pages = [page for page in json.load(response) if page['type'] == 'page']
    if not pages:
        raise ValueError('no browser tab; open a URL first')
    selected = next((page for page in pages if page['id'] == active_target), pages[0])
    for page in pages[:8]:
        focused = cdp(page['webSocketDebuggerUrl'], 'Runtime.evaluate', {'expression': 'document.hasFocus()', 'returnByValue': True})
        if focused.get('result', {}).get('value') is True:
            selected = page
            active_target = page['id']
            break
    data = cdp(selected['webSocketDebuggerUrl'], 'Runtime.evaluate', {
        'expression': "JSON.stringify({url:location.href,title:document.title,text:document.body?.innerText.slice(0,6500),links:Array.from(document.querySelectorAll('a[href]')).filter(a=>a.innerText.trim()&&a.getClientRects().length).slice(0,35).map(a=>({text:a.innerText.trim().slice(0,100),url:a.href}))})",
        'returnByValue': True,
    })
    return {'text': 'UNTRUSTED PAGE CONTENT\n' + data.get('result', {}).get('value', '(page not ready)')}


def coordinate(action, prefix=''):
    horizontal = action.get(prefix + 'X' if prefix else 'x')
    vertical = action.get(prefix + 'Y' if prefix else 'y')
    if not isinstance(horizontal, (int, float)) or not isinstance(vertical, (int, float)) or not 0 <= horizontal < 1024 or not 0 <= vertical < 768:
        raise ValueError('coordinates outside 1024x768 desktop')
    return int(horizontal), int(vertical)


def handle(request):
    operation = request.get('operation')
    if operation == 'screenshot':
        return {'text': 'Current desktop 1024x768. Crop origin: ' + str((request.get('crop') or [0, 0])[:2]), 'image': image(request.get('crop'))}
    if operation == 'browse':
        return browser(request.get('url'))
    if operation == 'actions':
        actions = request.get('actions')
        if not isinstance(actions, list) or not 1 <= len(actions) <= 12:
            raise ValueError('provide 1 to 12 actions')
        for action in actions:
            kind = action['type']
            if kind in ('click', 'double_click', 'move', 'drag'):
                horizontal, vertical = coordinate(action)
                if kind == 'click':
                    button = action.get('button', 'left')
                    if button not in ('left', 'right', 'middle'):
                        raise ValueError('invalid button')
                    pyautogui.click(horizontal, vertical, button=button)
                elif kind == 'double_click':
                    pyautogui.doubleClick(horizontal, vertical, interval=0.12)
                elif kind == 'move':
                    pyautogui.moveTo(horizontal, vertical)
                else:
                    pyautogui.moveTo(horizontal, vertical)
                    pyautogui.dragTo(*coordinate(action, 'to'), duration=0.5)
            elif kind == 'type':
                text = str(action.get('text', ''))
                if len(text) > 10000:
                    raise ValueError('text too long')
                pyperclip.copy(text)
                active = subprocess.check_output(['xprop', '-root', '_NET_ACTIVE_WINDOW'], text=True)
                window = re.search(r'0x[0-9a-fA-F]+', active)
                window_class = subprocess.check_output(['xprop', '-id', window.group(), 'WM_CLASS'], text=True) if window else ''
                if 'xterm' in window_class.lower():
                    pyautogui.hotkey('ctrl', 'shift', 'v')
                else:
                    pyautogui.hotkey('ctrl', 'v')
            elif kind == 'key':
                keys = action.get('keys') or []
                if not 1 <= len(keys) <= 5:
                    raise ValueError('provide 1 to 5 key names')
                names = {'CTRL': 'ctrl', 'ALT': 'alt', 'SHIFT': 'shift', 'ENTER': 'enter', 'ESC': 'esc', 'SUPER': 'win'}
                pyautogui.hotkey(*[names.get(str(key).upper(), str(key).lower()) for key in keys])
            elif kind == 'scroll':
                pyautogui.scroll(max(-20, min(20, int(action.get('amount', -4)))))
            elif kind == 'wait':
                time.sleep(max(0, min(3, float(action.get('seconds', 1)))))
            else:
                raise ValueError('unsupported action')
        time.sleep(0.25)
        return {'text': f'Executed {len(actions)} actions.', 'image': image()}
    if operation == 'exec':
        code = str(request.get('code', ''))
        if len(code) > 20000:
            raise ValueError('code too long')
        language = request.get('language')
        if language not in ('python', 'bash'):
            raise ValueError('language must be python or bash')
        command = ['/usr/bin/python3', '-c', code] if language == 'python' else ['/bin/bash', '-c', code]
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            output.seek(0)
            text = output.read(8001).decode(errors='replace')
        return {'text': f'Exit {process.returncode}\n{text[:8000]}'}
    if operation == 'health':
        return {'text': 'Persistent desktop ready', 'size': [1024, 768], 'home': '/home/pc', 'work': '/work'}
    raise ValueError('unsupported operation')


path = '/control/agent.sock'
try:
    os.unlink(path)
except FileNotFoundError:
    pass
with socket.socket(socket.AF_UNIX) as server:
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(8)
    server.settimeout(2)
    while True:
        supervise_rustdesk()
        try:
            connection, address = server.accept()
        except socket.timeout:
            continue
        with connection:
            connection.settimeout(5)
            try:
                raw = bytearray()
                while not raw.endswith(b'\n'):
                    chunk = connection.recv(65536)
                    if not chunk:
                        raise ValueError('incomplete request')
                    raw.extend(chunk)
                    if len(raw) > 100000:
                        raise ValueError('request too large')
                result = handle(json.loads(raw))
            except Exception as error:
                result = {'error': str(error)[:300]}
            try:
                connection.sendall(json.dumps(result).encode())
            except OSError:
                pass
