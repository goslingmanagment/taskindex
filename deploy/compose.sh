#!/usr/bin/env bash
set -Eeuo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
source "$repo/deploy/common.sh"
load_current_release
dc "$@"
