import hashlib
import json
from pathlib import Path
import platform
import subprocess

STATE = Path('/var/lib/uos-guest-probe')

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def emit(text):
    with open('/dev/ttyAMA0', 'w') as serial:
        serial.write(text)
        serial.flush()

try:
    expected = json.loads((STATE / 'expected.json').read_text())
    initial = (STATE / 'initial-boot-id').read_text().strip()
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    release = platform.release()
    if boot == initial or release != expected['kernelRelease'] or platform.machine() != 'aarch64':
        raise RuntimeError('not the selected post-install ARM64 kernel reboot')
    config = Path('/boot') / ('config-' + release)
    if sha(config) != expected['configSha256']:
        raise RuntimeError('selected kernel configuration changed')
    lsm = Path('/sys/kernel/security/lsm').read_text().strip()
    if 'landlock' not in lsm.split(','):
        raise RuntimeError('Landlock is not boot-enabled')
    seed = Path('/mnt/uos-probe-payload')
    seed.mkdir(exist_ok=True)
    subprocess.run(['mount', '-o', 'ro', '/dev/disk/by-label/CIDATA', str(seed)], check=True)
    hashes = {name: sha(seed / filename) for name, filename in [('kernel', 'kernel.deb'), ('modules', 'modules.deb'), ('probe', 'probe')]}
    if hashes != expected['hashes'] or sha(STATE / 'probe') != hashes['probe']:
        raise RuntimeError('public probe payload changed')
    child = subprocess.run([str(STATE / 'probe')], capture_output=True, text=True)
    calls = json.loads(child.stdout)
    result = {'v': 1, 'nonce': expected['nonce'], 'sourceSha': expected['sourceSha'], 'phase': 'post-kernel-reboot', 'initialBootId': initial, 'bootId': boot, 'kernelRelease': release, 'arch': platform.machine(), 'configSha256': sha(config), 'lsm': lsm, 'hashes': hashes, 'probeExit': child.returncode, 'syscalls': calls}
    body = json.dumps(result, separators=(',', ':'))
    emit('\nUOS_LINUX_GUEST_RECEIPT ' + body + '\nUOS_LINUX_GUEST_DONE ' + expected['nonce'] + ' ' + hashlib.sha256(body.encode()).hexdigest() + '\n')
except Exception as error:
    emit('\nUOS_LINUX_GUEST_ERROR ' + str(error).replace('\n', ' ') + '\n')
finally:
    subprocess.run(['systemctl', 'poweroff', '--no-block'], check=False)
