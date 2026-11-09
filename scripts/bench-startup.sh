#!/bin/sh
# 启动耗时基线：每条命令跑 N 次取中位数（毫秒）。
# 用法：sh scripts/bench-startup.sh [产物路径，默认 dist/astra.mjs] [次数，默认 7]
# 只跑不碰网络、不写库的命令，结果只用来前后对比。
BIN=${1:-dist/astra.mjs}
N=${2:-7}
NODE=${NODE:-node}
median() { sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}'; }
for cmd in "version" "help" "bili get --help" "music have --help" "novel search --help"; do
  times=""
  i=0
  while [ $i -lt "$N" ]; do
    s=$(date +%s%N)
    # shellcheck disable=SC2086
    $NODE "$BIN" $cmd >/dev/null 2>&1
    e=$(date +%s%N)
    times="$times $(( (e - s) / 1000000 ))"
    i=$((i + 1))
  done
  echo "$(echo $times | tr ' ' '\n' | median)ms  $cmd"
done
