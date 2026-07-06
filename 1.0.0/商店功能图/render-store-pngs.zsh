#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
render_dir="${1:-$script_dir}"

python3 "$script_dir/render-store-pngs.py" "$render_dir"
