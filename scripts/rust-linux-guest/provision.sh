#!/bin/sh
set -eu
exec >/dev/ttyAMA0 2>&1
seed=/mnt/uos-seed
state=/var/lib/uos-guest-probe
failed() { printf '\nUOS_LINUX_GUEST_ERROR provisioning-failed\n'; systemctl poweroff --no-block || :; }
trap failed EXIT
for tool in python3 dpkg update-initramfs update-grub systemctl sha256sum findmnt df; do command -v "$tool" >/dev/null; done
cd "$seed"
sha256sum -c payload.sha256
mkdir -p "$state"
chmod 700 "$state"
cp expected.json receipt.py probe "$state/"
chmod 700 "$state/probe"
cat /proc/sys/kernel/random/boot_id > "$state/initial-boot-id"
release=$(python3 -c 'import json; print(json.load(open("expected.json"))["kernelRelease"])')
printf '\nUOS_LINUX_GUEST_ROOT_CAPACITY pre-dpkg\n'
findmnt -n -o SOURCE,FSTYPE /
df -k /
dpkg -i "$seed/modules.deb" "$seed/kernel.deb"
if test -f "/boot/initrd.img-$release"; then update-initramfs -u -k "$release"; else update-initramfs -c -k "$release"; fi
mkdir -p /etc/default/grub.d
printf 'GRUB_DEFAULT=0\nGRUB_SAVEDEFAULT=false\n' > /etc/default/grub.d/99-uos-ci.cfg
update-grub
cat > /etc/systemd/system/uos-guest-probe.service <<'UNIT'
[Unit]
Description=One public offline Linux capability probe
After=cloud-final.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /var/lib/uos-guest-probe/receipt.py
TimeoutStartSec=60
StandardOutput=tty
StandardError=tty
TTYPath=/dev/ttyAMA0
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable uos-guest-probe.service
trap - EXIT
systemctl reboot --no-block
