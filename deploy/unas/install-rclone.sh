#!/bin/sh
# Lagringstjeneste for foto.dalhus.net på UNAS: `rclone serve s3` over mappa «Publisert».
# Kjøres som root på UNAS. Trygg å kjøre flere ganger (f.eks. etter en firmware-oppdatering):
#   sh /persistent/rclone/install-rclone.sh
# Første gang må FOTO_AUTH (tilgangsnøkkel,hemmelighet) settes i /persistent/rclone/foto-s3.env.
set -eu
V=v1.75.2
D=/persistent/rclone
DATA=/volume/1c2d770c-b3b4-4688-a33e-bdf2bccf0ceb/.srv/.unifi-drive/Publisert/.data
mkdir -p "$D"

if [ ! -x "$D/rclone" ] || ! "$D/rclone" version 2>/dev/null | grep -q "rclone $V"; then
	cd /tmp
	curl -fsSLO "https://downloads.rclone.org/$V/rclone-$V-linux-arm64.zip"
	curl -fsSL "https://downloads.rclone.org/$V/SHA256SUMS" | grep " rclone-$V-linux-arm64.zip\$" | sha256sum -c -
	python3 -c "import zipfile; zipfile.ZipFile('rclone-$V-linux-arm64.zip').extract('rclone-$V-linux-arm64/rclone', '.')"
	install -m 755 "rclone-$V-linux-arm64/rclone" "$D/rclone"
	rm -rf "rclone-$V-linux-arm64" "rclone-$V-linux-arm64.zip"
fi

# Bøttene er vanlige mapper: originaler/ og database/
for b in originaler database; do
	mkdir -p "$DATA/$b"
	chown unifi-drive:unifi-drive "$DATA/$b"
	chmod 770 "$DATA/$b"
done

test -s "$D/foto-s3.env" || { echo "Mangler $D/foto-s3.env (FOTO_AUTH=nøkkel,hemmelighet)"; exit 1; }
chmod 600 "$D/foto-s3.env"

cat > "$D/foto-s3.service" <<UNIT
[Unit]
Description=Foto: S3-lagring (rclone) for foto.dalhus.net
After=network-online.target
StartLimitIntervalSec=0

[Service]
User=unifi-drive
Group=unifi-drive
EnvironmentFile=$D/foto-s3.env
# Vent til volumet er montert, ellers ville rclone servert en tom mappe.
ExecStartPre=/usr/bin/test -d $DATA/originaler
ExecStart=$D/rclone serve s3 $DATA --addr 127.0.0.1:8099 --auth-key \${FOTO_AUTH} --log-level NOTICE
Restart=always
RestartSec=20
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
cp "$D/foto-s3.service" /etc/systemd/system/foto-s3.service
systemctl daemon-reload
systemctl enable foto-s3.service >/dev/null 2>&1
systemctl restart foto-s3.service
sleep 2
systemctl is-active foto-s3.service
