#!/bin/bash
# Burst real screenshots: shots.sh <dir>. Stops when <dir>/stop exists.
SIM=${SIM:?set SIM to the simulator UDID}
d=$1; mkdir -p "$d"; i=0
while [ ! -e "$d/stop" ]; do
  i=$((i+1)); f=$(printf '%s/%05d.png' "$d" $i)
  xcrun simctl io $SIM screenshot "$f" >/dev/null 2>&1
done
