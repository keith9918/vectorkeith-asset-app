#!/bin/bash
# ───────────────────────────────────────────────────────────────
#  VK 链（单节点测试网，Solana Agave + Alpenglow 共识）安装 / 重新创世
#    bash setup-chain.sh dev <金库公钥> <水龙头公钥> <储备公钥>   开发链：私钥在开发电脑上
#    bash setup-chain.sh prod                                       正式链：金库/水龙头/储备私钥在服务器上生成，不离开服务器
#  注意：会清空旧账本，从创世区块重新开始。正式链上需要 VKCHAIN_WIPE=yes-wipe-official-chain 才会执行。
#  创世总量正好 10 亿 VK：先试跑一次读出系统账户占用，再把差额补进"生态储备"。
# ───────────────────────────────────────────────────────────────
set -euo pipefail
MODE=${1:?usage: setup-chain.sh dev|prod ...}
VER=v4.3.2
ROOT=${VKCHAIN_ROOT:-/opt/vkchain}
BIN=$ROOT/releases/$VER/bin
APPDATA=/opt/vectorkeith/data/chain
TARGET=1000000000000000000          # 创世总量 10 亿 VK（1 VK = 10^9 最小单位）
FAUCET_LAMPORTS=10000000000000000   # 水龙头 1000 万 VK
R0=487999486000000000               # 生态储备初值（试跑后精确调整）

# 正式链保护（2026-11-23 起是正式链）：账本已存在时，重新创世会清空所有人的 VK 和资产
if [ -d "$ROOT/ledger" ] && [ "${VKCHAIN_WIPE:-}" != "yes-wipe-official-chain" ]; then
  echo "VK 链已经是正式链：重新创世会清空所有人的 VK 和资产，已停止。" >&2
  echo "确实要清空：先备份（bash /opt/vkchain/backup.sh），再运行 VKCHAIN_WIPE=yes-wipe-official-chain bash setup-chain.sh $MODE" >&2
  exit 1
fi

rpc() { curl -s -m 5 "http://127.0.0.1:$1" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }
wait_healthy() {
  for _ in $(seq 1 90); do
    [ "$(rpc "$1" getHealth | grep -c '"ok"')" = 1 ] && return 0
    sleep 1
  done
  echo "节点没有在 90 秒内就绪" >&2
  return 1
}

# 1) 交换空间：2G 内存的机器上给节点和 App 留余量（只加一次）
if ! swapon --show | grep -q '^/swapfile'; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/60-vkchain-swappiness.conf && sysctl -q -p /etc/sysctl.d/60-vkchain-swappiness.conf
  echo "已添加 2G 交换空间"
fi

# 程序文件对所有用户只读可执行（不含任何私钥）；账本目录只有 vkchain 能读写
chmod 755 $ROOT $ROOT/releases
ln -sfn $ROOT/releases/$VER $ROOT/current

# 2) 金库 / 水龙头 / 储备
if [ "$MODE" = prod ]; then
  install -d -o vectorkeith -g vectorkeith -m 700 $APPDATA $APPDATA/keys
  for k in treasury faucet reserve; do
    [ -f $APPDATA/keys/$k.json ] || runuser -u vectorkeith -- $BIN/solana-keygen new --no-bip39-passphrase -s -o $APPDATA/keys/$k.json >/dev/null
    chmod 600 $APPDATA/keys/$k.json
  done
  pub() { runuser -u vectorkeith -- $BIN/solana-keygen pubkey $APPDATA/keys/$1.json; }
  TREASURY=$(pub treasury); FAUCET=$(pub faucet); RESERVE=$(pub reserve)
else
  TREASURY=${2:?treasury}; FAUCET=${3:?faucet}; RESERVE=${4:?reserve}
fi
echo "金库 $TREASURY  水龙头 $FAUCET  储备 $RESERVE"

# 3) 创世账户文件（solana account --output json 格式）
install -d -o vkchain -g vkchain -m 755 $ROOT/genesis
acct() {
  printf '{"pubkey":"%s","account":{"lamports":%s,"data":["","base64"],"owner":"11111111111111111111111111111111","executable":false,"rentEpoch":18446744073709551615,"space":0}}\n' "$1" "$2" > $ROOT/genesis/$3.json
  chown vkchain:vkchain $ROOT/genesis/$3.json
}
acct $FAUCET $FAUCET_LAMPORTS faucet
acct $RESERVE $R0 reserve
COMMON="--mint $TREASURY --inflation-fixed 0 --faucet-sol 1 --limit-blockstore-size 2000000 --alpenglow \
  --account-index spl-token-owner --account-index spl-token-mint \
  --account $FAUCET $ROOT/genesis/faucet.json --account $RESERVE $ROOT/genesis/reserve.json --quiet"
LIMITS="-p MemoryMax=1300M -p MemorySwapMax=512M -p CPUQuota=100% -p CPUWeight=10 -p Nice=19 -p LimitNOFILE=1000000 -p IPAddressDeny=any -p IPAddressAllow=localhost"

systemctl stop vkchain 2>/dev/null || true

# 4) 试跑：读出创世总量，算出储备需要补多少
rm -rf $ROOT/genesis-probe && install -d -o vkchain -g vkchain $ROOT/genesis-probe
systemctl reset-failed vkchain-genesis 2>/dev/null || true
systemd-run --quiet --unit=vkchain-genesis --uid=vkchain --gid=vkchain $LIMITS --working-directory=$ROOT \
  $BIN/solana-test-validator --ledger $ROOT/genesis-probe --rpc-port 18899 --faucet-port 19900 --dynamic-port-range 18000-18200 $COMMON
trap 'systemctl stop vkchain-genesis 2>/dev/null || true' EXIT
wait_healthy 18899
# 头几个块里还会补建系统账户（总量会变），等到第 20 个块以后、两次读数一致再取
for _ in $(seq 1 60); do
  [ "$(rpc 18899 getSlot | jget '["result"]')" -ge 20 ] && break
  sleep 1
done
for _ in $(seq 1 10); do
  T1=$(rpc 18899 getSupply | jget '["result"]["value"]["total"]'); sleep 3
  [ "$(rpc 18899 getSupply | jget '["result"]["value"]["total"]')" = "$T1" ] && break
done
systemctl stop vkchain-genesis; systemctl reset-failed vkchain-genesis 2>/dev/null || true
trap - EXIT
rm -rf $ROOT/genesis-probe
R=$(( R0 + TARGET - T1 ))
acct $RESERVE $R reserve
echo "试跑总量 $T1 → 储备调整为 $R"

# 5) 正式节点（systemd 服务）
rm -rf $ROOT/ledger && install -d -o vkchain -g vkchain -m 750 $ROOT/ledger
cat > /etc/systemd/system/vkchain.service <<EOF
[Unit]
Description=VK Chain test network node (Agave solana-test-validator $VER, Alpenglow, single node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vkchain
Group=vkchain
WorkingDirectory=$ROOT
Environment=RUST_LOG=warn
# 清理 7 天前的旧日志（每次启动会新建一个日志文件）
ExecStartPre=-/usr/bin/find $ROOT/ledger -maxdepth 1 -name 'validator-*.log' -mtime +7 -delete
ExecStart=$ROOT/current/bin/solana-test-validator --ledger $ROOT/ledger --rpc-port 8899 --faucet-port 9900 --dynamic-port-range 8000-8100 $COMMON
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
# 资源上限：最多 1 个核、低优先级（App 优先），内存超过上限只会重启节点，不影响 App
CPUQuota=100%
CPUWeight=10
Nice=19
IOSchedulingClass=best-effort
IOSchedulingPriority=7
MemoryHigh=1100M
MemoryMax=1300M
MemorySwapMax=512M
LimitNOFILE=1000000
# 网络隔离：节点只和本机通信（RPC 由 App 代理对外），外网连不到任何节点端口
IPAddressDeny=any
IPAddressAllow=localhost
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$ROOT/ledger

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now vkchain >/dev/null 2>&1
wait_healthy 8899
# 同上：等头几个块补建完系统账户、总量稳定后再核对
for _ in $(seq 1 60); do
  [ "$(rpc 8899 getSlot | jget '["result"]')" -ge 20 ] && break
  sleep 1
done
for _ in $(seq 1 10); do
  TOTAL=$(rpc 8899 getSupply | jget '["result"]["value"]["total"]'); sleep 3
  [ "$(rpc 8899 getSupply | jget '["result"]["value"]["total"]')" = "$TOTAL" ] && break
done
GENESIS=$(rpc 8899 getGenesisHash | jget '["result"]')
IDENTITY=$(rpc 8899 getIdentity | jget '["result"]["identity"]')
VOTE=$(rpc 8899 getVoteAccounts | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; v=r['current']+r['delinquent']; print(v[0]['votePubkey'] if v else '')")
echo "创世总量 $TOTAL（目标 $TARGET）  genesis $GENESIS"
[ "$TOTAL" = "$TARGET" ] || { echo "总量不等于目标！" >&2; exit 1; }

INFO="{\"genesisHash\":\"$GENESIS\",\"createdAt\":$(date +%s),\"supply\":\"$TARGET\",\"treasury\":\"$TREASURY\",\"faucet\":\"$FAUCET\",\"reserve\":\"$RESERVE\",\"faucetGenesis\":\"$FAUCET_LAMPORTS\",\"reserveGenesis\":\"$R\",\"identity\":\"$IDENTITY\",\"vote\":\"$VOTE\",\"consensus\":\"alpenglow\",\"version\":\"${VER#v}\"}"
if [ "$MODE" = prod ]; then
  echo "$INFO" > $APPDATA/genesis.json && chown vectorkeith:vectorkeith $APPDATA/genesis.json
fi
echo "GENESIS_JSON $INFO"
ss -lntup | grep -E ':(8899|8900|9900)\b' | awk '{print "监听", $1, $5}'
