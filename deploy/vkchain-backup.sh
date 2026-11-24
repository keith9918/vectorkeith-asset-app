#!/bin/bash
# ───────────────────────────────────────────────────────────────
#  VK 链每日备份（systemd 定时器 vkchain-backup.timer，北京时间每天 04:00）
#  内容：创世文件 + 最新账户快照（全部余额 / 资产都在里面）+ 节点密钥 + App 的链数据
#        （金库 / 水龙头 / 储备私钥、交易索引、资产图标）。约 1 MB，保留 30 份，权限 600。
#  区块数据（rocksdb）不备份：节点本来就只保留最近几小时，交易记录在 App 的索引里。
#
#  恢复（会丢失最后一次备份之后的交易）：
#    systemctl stop vkchain
#    mv /opt/vkchain/ledger /opt/vkchain/ledger.broken-$(date +%s)
#    mkdir -p /tmp/vkr && tar -xzf /var/backups/vkchain/vkchain-<日期>.tar.gz -C /tmp/vkr
#    install -d -o vkchain -g vkchain -m 750 /opt/vkchain/ledger
#    cp -a /tmp/vkr/ledger/. /opt/vkchain/ledger/ && chown -R vkchain:vkchain /opt/vkchain/ledger
#    # App 的链数据也丢了才需要：
#    # cp -a /tmp/vkr/app/. /opt/vectorkeith/data/chain/ && chown -R vectorkeith:vectorkeith /opt/vectorkeith/data/chain
#    systemctl start vkchain
# ───────────────────────────────────────────────────────────────
set -euo pipefail
L=/opt/vkchain/ledger
OUT=/var/backups/vkchain
KEEP=30
install -d -m 700 "$OUT"
SNAP=$(ls -1t "$L"/snapshot-*.tar.zst 2>/dev/null | head -1)
[ -n "$SNAP" ] || { echo "没有找到账户快照" >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/ledger" "$TMP/app"
cp -a "$L/genesis.bin" "$L/genesis.tar.bz2" "$SNAP" "$L"/*-keypair.json "$TMP/ledger/"
cp -a "$L"/tower-*.bin "$TMP/ledger/" 2>/dev/null || true
cp -a /opt/vectorkeith/data/chain/. "$TMP/app/"
F="$OUT/vkchain-$(date +%Y%m%d-%H%M).tar.gz"
tar -czf "$F" -C "$TMP" .
chmod 600 "$F"
ls -1t "$OUT"/vkchain-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "备份完成：$F（$(du -h "$F" | cut -f1)，快照 $(basename "$SNAP")）"
